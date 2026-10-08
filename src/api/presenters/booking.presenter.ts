import type { IBooking, IBookingOffer, IBookingStatusHistory } from '../../interfaces/IBooking';
import { decryptNullable } from '../../utils/crypto/field-encryption';
import { chatOpen } from '../../services/chat/chat-window';
import { BookingStatus } from '../../interfaces/IBooking';
import type { IPatientProfile } from '../../interfaces/IProfiles';
import type { IAllergy, IMedicalCondition, IMedication } from '../../interfaces/IMedical';
import type { Language } from '../../utils/i18n';
import { localized } from './localize';
import { ageFrom } from './patient.presenter';
import { discountsOf } from '../../services/booking/pricing';

/** Maps bookings to the API shapes in booking.validation.ts. */

const serviceName = (b: IBooking, lang: Language) => localized(b.service.nameAr, b.service.nameEn, lang);

export type ProviderCardInfo = { id: string; name: string; phone: string | null; ratingAvg: number };

export const presentQuote = (q: {
  draft: {
    price: IBooking['price'];
    promoCode?: string | null;
    packageSubscriptionId?: string | null;
  };
  lines: Array<{ label: string; amount: number }>;
  cancellationPolicy: string;
  token: string;
  expiresAt: Date;
  cashAvailable: boolean;
}) => ({
  subtotal: q.draft.price.subtotal,
  travel_fee: q.draft.price.travelFee,
  discount: q.draft.price.discount,
  platform_fee: q.draft.price.platformFee,
  total: q.draft.price.total,
  currency: 'EGP' as const,
  discounts: discountsOf(q.draft.price),
  promo_code: q.draft.promoCode ?? null,
  package_subscription_id: q.draft.packageSubscriptionId ?? null,
  lines: q.lines,
  cancellation_policy: q.cancellationPolicy,
  payment_required: q.draft.price.total > 0,
  cash_available: q.cashAvailable,
  quote_token: q.token,
  expires_at: q.expiresAt.toISOString(),
});

export const presentCreated = (
  b: IBooking,
  payment: { id: string; checkoutUrl: string | null; expiresAt: Date } | null = null,
) => ({
  id: String(b._id),
  reference_code: b.referenceCode,
  status: b.status,
  payment_method: b.paymentMethod,
  payment_status: b.paymentStatus,
  payment_action: payment?.checkoutUrl
    ? {
        payment_id: payment.id,
        checkout_url: payment.checkoutUrl,
        expires_at: payment.expiresAt.toISOString(),
      }
    : null,
});

export const presentListItem = (
  b: IBooking,
  provider: ProviderCardInfo | undefined,
  lang: Language,
  organization: { id: string; name: string } | null = null,
) => ({
  id: String(b._id),
  reference_code: b.referenceCode,
  status: b.status,
  type: b.type,
  service_name: serviceName(b, lang),
  scheduled_start: b.scheduledStart.toISOString(),
  scheduled_end: b.scheduledEnd.toISOString(),
  provider_name: provider?.name ?? null,
  organization_name: organization?.name ?? null,
  total: b.price.total,
  currency: 'EGP' as const,
});

export const presentDetail = (input: {
  booking: IBooking;
  timeline: IBookingStatusHistory[];
  provider: ProviderCardInfo | null;
  /** Booked with an organization (its staff member is `provider` once assigned). */
  organization?: { id: string; name: string } | null;
  avatarUrl: string | null;
  flags: { canCancel: boolean; canReschedule: boolean; canReview: boolean; canChat: boolean };
  visitReportId: string | null;
  lang: Language;
}) => {
  const b = input.booking;
  return {
    id: String(b._id),
    reference_code: b.referenceCode,
    type: b.type,
    status: b.status,
    service: { id: String(b.serviceId), name: serviceName(b, input.lang) },
    patient_profile: { id: String(b.patientProfileId) },
    address: { label: b.address.label, full_text: b.address.fullText },
    scheduled_start: b.scheduledStart.toISOString(),
    scheduled_end: b.scheduledEnd.toISOString(),
    provider: input.provider
      ? {
          id: input.provider.id,
          name: input.provider.name,
          avatar_url: input.avatarUrl,
          is_verified: true as const,
          rating_avg: input.provider.ratingAvg,
          // Revealed once the provider has accepted (decision 2).
          phone: b.status === BookingStatus.PENDING ? null : input.provider.phone,
        }
      : null,
    organization: input.organization ?? null,
    price: {
      subtotal: b.price.subtotal,
      travel_fee: b.price.travelFee,
      discount: b.price.discount,
      discounts: discountsOf(b.price),
      total: b.price.total,
      currency: 'EGP' as const,
    },
    promo_code: b.promo?.code ?? null,
    package_subscription_id: b.packageSubscriptionId ? String(b.packageSubscriptionId) : null,
    payment_method: b.paymentMethod,
    payment_status: b.paymentStatus,
    // The only "tracking": status changes the provider makes by hand. No location fields (spec §1).
    timeline: input.timeline.map((h) => ({
      status: h.toStatus,
      at: h.createdAt.toISOString(),
      note: h.note,
    })),
    can_cancel: input.flags.canCancel,
    can_reschedule: input.flags.canReschedule,
    can_review: input.flags.canReview,
    can_chat: input.flags.canChat,
    visit_report_id: input.visitReportId,
    video: null, // video: Phase 2
  };
};

export const presentProviderItem = (b: IBooking, lang: Language) => ({
  id: String(b._id),
  reference_code: b.referenceCode,
  status: b.status,
  service_name: serviceName(b, lang),
  area_name: b.address.areaNameAr,
  scheduled_start: b.scheduledStart.toISOString(),
  scheduled_end: b.scheduledEnd.toISOString(),
  total: b.price.total,
  provider_payout: b.price.providerPayout,
  payment_method: b.paymentMethod,
});

export const presentProviderDetail = (input: {
  booking: IBooking;
  patientProfile: IPatientProfile | null;
  patientPhone: string | null;
  medical: { conditions: IMedicalCondition[]; medications: IMedication[]; allergies: IAllergy[] } | null;
  allowedActions: string[];
  lang: Language;
}) => {
  const b = input.booking;
  const revealed = b.status !== BookingStatus.PENDING;
  return {
    id: String(b._id),
    reference_code: b.referenceCode,
    status: b.status,
    type: b.type,
    service: { name: serviceName(b, input.lang), pricing_unit: b.service.pricingUnit, quantity: b.quantity },
    scheduled_start: b.scheduledStart.toISOString(),
    scheduled_end: b.scheduledEnd.toISOString(),
    patient:
      revealed && input.patientProfile
        ? {
            full_name: input.patientProfile.fullName,
            age: ageFrom(input.patientProfile.dateOfBirth),
            gender: input.patientProfile.gender,
            phone: input.patientPhone,
          }
        : null,
    address: {
      area_name: b.address.areaNameAr,
      full_text: revealed ? b.address.fullText : null,
      landmark: revealed ? b.address.landmark : null,
      notes: revealed ? b.address.notes : null,
    },
    medical_summary: input.medical
      ? {
          conditions: input.medical.conditions.map((c) => c.name),
          medications: input.medical.medications.map((m) => [m.name, m.dosage].filter(Boolean).join(' ')),
          allergies: input.medical.allergies.map((a) => a.name),
        }
      : null,
    patient_notes: revealed ? decryptNullable(b.patientNotes) : null,
    price: { total: b.price.total, travel_fee: b.price.travelFee, provider_payout: b.price.providerPayout },
    payment_method: b.paymentMethod,
    payment_status: b.paymentStatus,
    is_on_time: b.isOnTime,
    allowed_actions: input.allowedActions,
    can_chat: chatOpen(b),
  };
};

export const presentOffer = (offer: IBookingOffer, b: IBooking, lang: Language) => ({
  id: String(offer._id),
  booking_id: String(b._id),
  service_name: serviceName(b, lang),
  area_name: b.address.areaNameAr,
  scheduled_start: b.scheduledStart.toISOString(),
  scheduled_end: b.scheduledEnd.toISOString(),
  provider_payout: b.price.providerPayout,
  expires_at: offer.expiresAt.toISOString(),
});
