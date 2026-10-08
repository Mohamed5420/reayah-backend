import jwt from 'jsonwebtoken';
import { Container, Service } from 'typedi';
import { ProviderProfileModel } from '../../database/models/provider/provider-profile.model';
import { UserModel } from '../../database/models/user/user.model';
import { UserStatus, VerificationStatus } from '../../interfaces/enums';
import { BookingType, PreferredGender, type IBookingPrice } from '../../interfaces/IBooking';
import { env } from '../../config/env.config';
import { cairoDate } from '../../utils/time/cairo';
import { t, type Language } from '../../utils/i18n';
import {
  AreaNotCoveredError,
  ConflictError,
  NotFoundError,
  SlotUnavailableError,
  ValidationError,
} from '../../utils/types-errors';
import { AddressService } from '../address/address.service';
import { addressFullText } from '../address/address-text';
import { CatalogService } from '../catalog/catalog.service';
import { DiscoveryService, assertQuantity } from '../discovery/discovery.service';
import { LocationService } from '../location/location.service';
import { PatientProfileService } from '../patient/patient-profile.service';
import { SettingsService } from '../settings/settings.service';
import { CommissionService } from '../payouts/commission.service';
import { computePrice, discountsOf } from './pricing';
import { CreditService } from '../marketing/credit.service';
import { PackageService } from '../marketing/package.service';
import { PromoService } from '../marketing/promo.service';

/** A quote is guaranteed for 10 minutes (spec §7.8). */
export const QUOTE_TTL_SECONDS = 600;

export type QuoteInput = {
  serviceId: string;
  providerId: string | null;
  organizationId: string | null;
  patientProfileId: string;
  addressId: string;
  type: BookingType;
  preferredGender: PreferredGender;
  allowFallback: boolean;
  scheduledStart: Date;
  quantity: number;
  /** Optional promo code (not with a package). */
  promoCode?: string | null;
  /** Book one visit of this package. */
  packageSubscriptionId?: string | null;
};

/** Everything needed to create the booking, as carried inside the signed quote token. */
export type BookingDraft = Omit<QuoteInput, 'scheduledStart' | 'providerId'> & {
  providerId: string;
  scheduledStart: string;
  scheduledEnd: string;
  price: IBookingPrice;
  /** The promo code the price used (redeemed when the booking is created). */
  promoCodeId?: string | null;
};

/**
 * Quotes (spec §6.1, §6.3, §6.11, §6.12, §7.8). `prepare()` runs every check a booking needs —
 * ownership, area, provider eligibility, current price bounds, travel-fee cap, a free slot — and is
 * re-run when the booking is created, so a quote can't be used to book something no longer valid.
 */
@Service()
export class QuoteService {
  private readonly profiles = Container.get(PatientProfileService);
  private readonly addresses = Container.get(AddressService);
  private readonly locations = Container.get(LocationService);
  private readonly catalog = Container.get(CatalogService);
  private readonly discovery = Container.get(DiscoveryService);
  private readonly settings = Container.get(SettingsService);

  async prepare(userId: string, input: QuoteInput, excludeBookingId?: string) {
    if (input.organizationId) {
      throw new ValidationError({ organization_id: ['validation.organizations_not_available'] });
    }
    if (!input.providerId) throw new ValidationError({ provider_id: ['validation.required'] });
    const settings = await this.settings.getAll();
    if (input.type === BookingType.VIDEO && !settings.features.video_consult) {
      throw new ValidationError({ type: ['validation.video_not_available'] });
    }

    const patientProfile = await this.profiles.getOwned(userId, input.patientProfileId);
    const address = await this.addresses.getOwned(userId, input.addressId);
    const area = await this.locations.findBookableArea(String(address.areaId));
    if (!area) throw new AreaNotCoveredError();
    const service = await this.catalog.getActiveService(input.serviceId);
    assertQuantity(service.pricingUnit, input.quantity);

    // Provider: approved, accepting, active account, covers the area, offers the service at a valid price.
    const provider = await ProviderProfileModel.findOne({
      _id: input.providerId,
      verificationStatus: VerificationStatus.APPROVED,
    }).lean();
    const providerUser = provider
      ? await UserModel.findOne({ _id: provider.userId, status: UserStatus.ACTIVE }).lean()
      : null;
    if (!provider || !providerUser) throw new NotFoundError('errors.provider_not_found');
    if (!provider.isAcceptingBookings) throw new ConflictError('errors.provider_not_accepting');
    const coverage = provider.serviceAreas.find((a) => String(a.areaId) === area.id);
    if (!coverage) throw new AreaNotCoveredError();
    const offered = provider.services.find((s) => s.isActive && String(s.serviceId) === service.id);
    if (!offered) throw new NotFoundError('errors.service_not_offered');
    if (
      (service.minPrice !== null && offered.price < service.minPrice) ||
      (service.maxPrice !== null && offered.price > service.maxPrice)
    ) {
      // The admin tightened the bounds after the provider set this price (BUILD_PLAN M1.4 note).
      throw new ConflictError('errors.provider_price_invalid');
    }
    if (
      input.preferredGender !== PreferredGender.ANY &&
      String(providerUser.gender) !== input.preferredGender
    ) {
      throw new ValidationError({ preferred_gender: ['validation.provider_gender_mismatch'] });
    }

    // The requested start must be a free slot right now.
    const slots = await this.discovery.providerSlots(
      input.providerId,
      service.id,
      cairoDate(input.scheduledStart),
      input.quantity,
      excludeBookingId,
    );
    const slot = slots.find((s) => s.available && s.start.getTime() === input.scheduledStart.getTime());
    if (!slot) throw new SlotUnavailableError();

    // Travel fee: the provider's fee for the area, never above the area's current cap (spec §4.2, §6.12).
    const travelFee =
      input.type === BookingType.VIDEO ? 0 : Math.min(coverage.travelFee, area.maxTravelFee ?? Infinity);
    const base = {
      unitPrice: offered.price,
      quantity: input.quantity,
      pricingUnit: service.pricingUnit,
      travelFee,
      commissionRate: settings.commission_rate,
    };

    // Discounts (M2.5), all borne by the platform. A reschedule keeps the booking's price, so only the
    // package's own rules are re-checked there (the booking already holds its visit).
    const rescheduling = Boolean(excludeBookingId);
    let packageSubscription = null;
    if (input.packageSubscriptionId) {
      if (input.promoCode) throw new ValidationError({ promo_code: ['validation.promo_with_package'] });
      packageSubscription = await Container.get(PackageService).assertUsable(
        userId,
        input.packageSubscriptionId,
        {
          patientProfileId: input.patientProfileId,
          serviceId: service.id,
          quantity: input.quantity,
          scheduledStart: input.scheduledStart,
          providerPrice: offered.price,
        },
        rescheduling,
      );
    }
    const promo =
      input.promoCode && !rescheduling
        ? await Container.get(PromoService).evaluate(userId, input.promoCode, {
            serviceId: service.id,
            subtotal: computePrice(base).subtotal,
          })
        : null;
    const price = computePrice({
      ...base,
      promoDiscount: promo?.discount ?? 0,
      coveredByPackage: Boolean(packageSubscription),
      availableCredit: rescheduling ? 0 : await Container.get(CreditService).balance(userId),
    });

    const draft: BookingDraft = {
      ...input,
      promoCode: promo ? promo.promo.code : null,
      packageSubscriptionId: packageSubscription ? String(packageSubscription._id) : null,
      providerId: input.providerId,
      scheduledStart: slot.start.toISOString(),
      scheduledEnd: slot.end.toISOString(),
      price,
      promoCodeId: promo ? String(promo.promo._id) : null,
    };
    return {
      draft,
      service,
      address,
      area,
      patientProfile,
      providerProfile: provider,
      providerUser,
      settings,
      packageSubscription,
    };
  }

  /** POST /bookings/quote — price breakdown + a token that guarantees it for 10 minutes. */
  async quote(userId: string, input: QuoteInput, lang: Language) {
    const prepared = await this.prepare(userId, input);
    const { draft, service, area, settings, packageSubscription } = prepared;
    const discounts = discountsOf(draft.price);
    const serviceName = lang === 'en' && service.nameEn ? service.nameEn : service.nameAr;
    const areaName = lang === 'en' && area.nameEn ? area.nameEn : area.nameAr;
    const lines = [
      {
        label: t('quote.service_line', { service: serviceName, quantity: draft.quantity }, lang),
        amount: draft.price.subtotal,
      },
      ...(draft.price.travelFee
        ? [{ label: t('quote.travel_line', { area: areaName }, lang), amount: draft.price.travelFee }]
        : []),
      ...(discounts.package && packageSubscription
        ? [
            {
              label: t(
                'quote.package_line',
                {
                  name:
                    (lang === 'en' && packageSubscription.package.nameEn) ||
                    packageSubscription.package.nameAr,
                },
                lang,
              ),
              amount: -discounts.package,
            },
          ]
        : []),
      ...(discounts.promo
        ? [{ label: t('quote.promo_line', { code: draft.promoCode ?? '' }, lang), amount: -discounts.promo }]
        : []),
      ...(discounts.credit ? [{ label: t('quote.credit_line', {}, lang), amount: -discounts.credit }] : []),
    ];
    const expiresAt = new Date(Date.now() + QUOTE_TTL_SECONDS * 1000);
    const token = jwt.sign({ typ: 'quote', sub: userId, draft }, env.jwt.secret, {
      algorithm: 'HS256',
      expiresIn: QUOTE_TTL_SECONDS,
    });
    return {
      ...prepared,
      lines,
      // Over the commission limit, a provider takes card / wallet only (product decision after M2.4).
      cashAvailable: !(await Container.get(CommissionService).overLimit(draft.providerId)),
      cancellationPolicy: t(
        'app_config.cancellation_policy',
        { hours: settings.cancellation_free_window_hours },
        lang,
      ),
      token,
      expiresAt,
    };
  }

  /** The draft inside a quote token issued to this user; 422 if expired, forged or someone else's. */
  verifyToken(token: string, userId: string): BookingDraft {
    try {
      const payload = jwt.verify(token, env.jwt.secret, { algorithms: ['HS256'] }) as jwt.JwtPayload;
      if (payload.typ !== 'quote' || payload.sub !== userId) throw new Error('wrong token');
      return payload.draft as BookingDraft;
    } catch {
      throw new ValidationError({ quote_token: ['validation.quote_invalid'] });
    }
  }

  /** Booking-time snapshot of the address (later edits to the saved address don't change the booking). */
  async addressSnapshot(address: Awaited<ReturnType<QuoteService['prepare']>>['address']) {
    const places = await this.locations.describeAreas([String(address.areaId)]);
    const place = places.get(String(address.areaId));
    return {
      label: address.label,
      governorateId: address.governorateId,
      areaId: address.areaId,
      areaNameAr: place?.area.nameAr ?? '',
      street: address.street,
      building: address.building,
      floor: address.floor,
      apartment: address.apartment,
      landmark: address.landmark,
      notes: address.notes,
      fullText: addressFullText(address, place, 'ar'),
    };
  }
}
