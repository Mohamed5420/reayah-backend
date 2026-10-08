import { Container, Service } from 'typedi';
import { Types, type ClientSession, type FilterQuery } from 'mongoose';
import { BookingModel } from '../../database/models/booking/booking.model';
import { PromoCodeModel, PromoRedemptionModel } from '../../database/models/marketing/marketing.models';
import { BookingStatus, type IBooking } from '../../interfaces/IBooking';
import { PromoType, type IPromoCode } from '../../interfaces/IMarketing';
import type { Language } from '../../utils/i18n';
import type { Pagination } from '../../utils/response/pagination';
import { escapeRegExp } from '../../utils/text/arabic';
import {
  NotFoundError,
  PromoExpiredError,
  PromoInvalidError,
  PromoLimitReachedError,
  ValidationError,
} from '../../utils/types-errors';
import { AuditService, applyPatch, type AuditContext } from '../audit/audit.service';

/** Booking statuses that don't make a patient "not new" for first-booking codes. */
const NOT_A_BOOKING = [BookingStatus.CANCELLED, BookingStatus.DECLINED, BookingStatus.EXPIRED];

export const normalizePromoCode = (code: string) => code.trim().toUpperCase();

/** The discount a code gives on a subtotal (piastres), never more than the subtotal. */
export const promoDiscount = (
  promo: Pick<IPromoCode, 'type' | 'value' | 'maxDiscount'>,
  subtotal: number,
) => {
  const raw =
    promo.type === PromoType.PERCENT
      ? Math.min(Math.round((subtotal * promo.value) / 100), promo.maxDiscount ?? Infinity)
      : promo.value;
  return Math.max(0, Math.min(raw, subtotal));
};

export const promoDescription = (promo: IPromoCode, lang: Language) =>
  (lang === 'en' && promo.descriptionEn) || promo.descriptionAr || null;

/**
 * Promo codes (spec §4.10, §7.9). `evaluate` is the one eligibility check (quote, booking, /validate);
 * `redeem` counts a use inside the booking transaction — the conditional increment serializes
 * concurrent bookings on the same code, so `max_uses` and `per_user_limit` can't be overrun. The
 * discount comes out of the platform's commission; the provider's payout is unchanged.
 */
@Service()
export class PromoService {
  async evaluate(
    userId: string,
    code: string,
    input: { serviceId: string; subtotal: number },
    now = new Date(),
  ) {
    const promo = await PromoCodeModel.findOne({ code: normalizePromoCode(code) }).lean();
    if (!promo || !promo.isActive || (promo.validFrom && now < promo.validFrom))
      throw new PromoInvalidError();
    if (promo.validTo && now > promo.validTo) throw new PromoExpiredError();
    if (promo.serviceIds.length && !promo.serviceIds.some((id) => String(id) === input.serviceId)) {
      throw new PromoInvalidError('errors.promo_not_for_service');
    }
    if (input.subtotal < promo.minSubtotal) throw new PromoInvalidError('errors.promo_min_subtotal');
    if (promo.maxUses !== null && promo.usesCount >= promo.maxUses) throw new PromoLimitReachedError();
    const used = await PromoRedemptionModel.countDocuments({
      promoCodeId: promo._id,
      userId,
      status: 'active',
    });
    if (used >= promo.perUserLimit) throw new PromoLimitReachedError();
    if (
      promo.firstBookingOnly &&
      (await BookingModel.exists({ patientUserId: userId, status: { $nin: NOT_A_BOOKING } }))
    ) {
      throw new PromoInvalidError('errors.promo_first_booking_only');
    }
    return { promo, discount: promoDiscount(promo, input.subtotal) };
  }

  /** Counts the use for a booking being created (inside its transaction). */
  async redeem(
    session: ClientSession,
    booking: Pick<IBooking, '_id' | 'patientUserId'>,
    promoCodeId: Types.ObjectId | string,
    discount: number,
  ) {
    const promo = await PromoCodeModel.findOneAndUpdate(
      {
        _id: promoCodeId,
        isActive: true,
        $or: [{ maxUses: null }, { $expr: { $lt: ['$usesCount', '$maxUses'] } }],
      },
      { $inc: { usesCount: 1 } },
      { new: true, session },
    );
    if (!promo) throw new PromoLimitReachedError();
    const used = await PromoRedemptionModel.countDocuments({
      promoCodeId,
      userId: booking.patientUserId,
      status: 'active',
    }).session(session);
    if (used >= promo.perUserLimit) throw new PromoLimitReachedError();
    await PromoRedemptionModel.create(
      [{ promoCodeId, userId: booking.patientUserId, bookingId: booking._id, discount }],
      { session },
    );
  }

  /** The booking ended without a visit: the use no longer counts. */
  async release(session: ClientSession, bookingId: Types.ObjectId) {
    const redemption = await PromoRedemptionModel.findOneAndUpdate(
      { bookingId, status: 'active' },
      { status: 'released' },
      { session },
    );
    if (!redemption) return;
    await PromoCodeModel.updateOne(
      { _id: redemption.promoCodeId, usesCount: { $gt: 0 } },
      { $inc: { usesCount: -1 } },
      { session },
    ).setOptions({ withDeleted: true });
  }
}

export type PromoInput = {
  code: string;
  descriptionAr?: string | null;
  descriptionEn?: string | null;
  type: PromoType;
  value: number;
  maxDiscount?: number | null;
  minSubtotal?: number;
  maxUses?: number | null;
  perUserLimit?: number;
  validFrom?: Date | null;
  validTo?: Date | null;
  serviceIds?: string[];
  firstBookingOnly?: boolean;
  isActive?: boolean;
};

/** Admin: /admin/promo-codes (spec §7.15 "Marketing"). Every write is audited. */
@Service()
export class PromoAdminService {
  private readonly audit = Container.get(AuditService);

  async list(filters: { isActive?: boolean; search?: string }, { skip, perPage }: Pagination) {
    const query: FilterQuery<IPromoCode> = {
      ...(filters.isActive !== undefined ? { isActive: filters.isActive } : {}),
      ...(filters.search ? { code: { $regex: escapeRegExp(normalizePromoCode(filters.search)) } } : {}),
    };
    const [data, total] = await Promise.all([
      PromoCodeModel.find(query).sort({ createdAt: -1 }).skip(skip).limit(perPage).lean(),
      PromoCodeModel.countDocuments(query),
    ]);
    return { data, total };
  }

  async create(input: PromoInput, context: AuditContext) {
    const promo = new PromoCodeModel({ ...input, code: normalizePromoCode(input.code) });
    assertPromoRules(promo);
    await promo.save();
    await this.audit.log(context, {
      action: 'promo_code.create',
      entityType: 'promo_code',
      entityId: String(promo._id),
      metadata: { input },
    });
    return promo.toObject();
  }

  async update(id: string, patch: Partial<PromoInput>, context: AuditContext) {
    const promo = Types.ObjectId.isValid(id) ? await PromoCodeModel.findById(id) : null;
    if (!promo) throw new NotFoundError('errors.promo_code_not_found');
    const changes = applyPatch(
      promo,
      patch.code ? { ...patch, code: normalizePromoCode(patch.code) } : patch,
    );
    assertPromoRules(promo);
    if (Object.keys(changes).length) {
      await promo.save();
      await this.audit.log(context, {
        action: 'promo_code.update',
        entityType: 'promo_code',
        entityId: id,
        metadata: { changes },
      });
    }
    return promo.toObject();
  }

  /** Spec: DELETE deactivates (bookings keep pointing at the code). */
  deactivate(id: string, context: AuditContext) {
    return this.update(id, { isActive: false }, context);
  }
}

const assertPromoRules = (promo: Pick<IPromoCode, 'type' | 'value' | 'validFrom' | 'validTo'>) => {
  if (promo.type === PromoType.PERCENT && promo.value > 100) {
    throw new ValidationError({ value: ['validation.percent_value'] });
  }
  if (promo.validFrom && promo.validTo && promo.validTo <= promo.validFrom) {
    throw new ValidationError({ valid_to: ['validation.valid_to_after_from'] });
  }
};
