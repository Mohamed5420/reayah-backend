import type { IUser } from '../../interfaces/IUser';
import type { IProviderProfile } from '../../interfaces/IProfiles';
import type { IProviderDocument } from '../../interfaces/IProvider';
import type { IBooking, IBookingOffer, IBookingStatusHistory } from '../../interfaces/IBooking';
import type { IAuditLog } from '../../interfaces/IAuditLog';
import type { IDispute, IUserSuspension, IUserWarning } from '../../interfaces/IAftercare';
import { decryptNullable } from '../../utils/crypto/field-encryption';
import { presentSpecialty } from '../../services/catalog/specialties';

/** Maps admin-panel data to the API shapes in admin.validation.ts. Admin views are Arabic-first. */

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export const presentAuditEntry = (e: IAuditLog) => ({
  id: String(e._id),
  actor_id: e.actorId ? String(e.actorId) : null,
  action: e.action,
  entity_type: e.entityType,
  entity_id: e.entityId,
  metadata: e.metadata,
  ip: e.ip,
  created_at: e.createdAt.toISOString(),
});

export const presentAdminUser = (u: IUser) => ({
  id: String(u._id),
  phone: u.phone,
  full_name: u.fullName,
  email: u.email,
  gender: u.gender,
  role: u.role,
  status: u.status,
  language: u.language,
  last_login_at: iso(u.lastLoginAt),
  created_at: u.createdAt.toISOString(),
});

/** No encrypted identity fields here — safe for lean (ciphertext) rows. */
const providerSummary = (p: IProviderProfile) => ({
  id: String(p._id),
  type: p.type,
  verification_status: p.verificationStatus,
  is_accepting_bookings: p.isAcceptingBookings,
  rating_avg: p.ratingAvg,
  rating_count: p.ratingCount,
  completed_visits: p.completedVisitsCount,
});

export const presentUserDetail = (input: {
  user: IUser;
  provider: IProviderProfile | null;
  bookings: number;
  cancellationRecord: {
    lateCancellations: number;
    travelFeeCharges: { count: number; total: number; uncollected: { count: number; total: number } };
  };
}) => ({
  user: presentAdminUser(input.user),
  provider_profile: input.provider ? providerSummary(input.provider) : null,
  bookings_count: input.bookings,
  cancellation_record: {
    late_cancellations: input.cancellationRecord.lateCancellations,
    travel_fee_charges: input.cancellationRecord.travelFeeCharges,
  },
});

export const presentProviderItem = ({ profile, user }: { profile: IProviderProfile; user: IUser }) => ({
  ...providerSummary(profile),
  user: { id: String(user._id), full_name: user.fullName, phone: user.phone, status: user.status },
});

/** `profile` must be decrypted (a `toObject()` of a hydrated document) — it carries license numbers. */
export const presentProviderDetail = (input: {
  profile: IProviderProfile;
  user: IUser;
  bookingsByStatus: Record<string, number>;
}) => ({
  ...providerSummary(input.profile),
  user: presentAdminUser(input.user),
  specialty: presentSpecialty(input.profile.specialty),
  years_of_experience: input.profile.yearsOfExperience,
  license_number: input.profile.licenseNumber,
  syndicate_number: input.profile.syndicateNumber,
  admin_message: input.profile.adminMessage,
  service_areas: input.profile.serviceAreas.map((a) => ({
    area_id: String(a.areaId),
    travel_fee: a.travelFee,
  })),
  services: input.profile.services.map((s) => ({
    service_id: String(s.serviceId),
    price: s.price,
    is_active: s.isActive,
  })),
  bookings_by_status: input.bookingsByStatus,
});

export const presentHistory = (h: {
  suspensions: IUserSuspension[];
  warnings: IUserWarning[];
  disputes: IDispute[];
  auditTrail: IAuditLog[];
}) => ({
  suspensions: h.suspensions.map((s) => ({
    id: String(s._id),
    reason: s.reason,
    starts_at: s.startsAt.toISOString(),
    ends_at: iso(s.endsAt),
    lifted_at: iso(s.liftedAt),
    created_by: s.createdBy ? String(s.createdBy) : null,
  })),
  warnings: h.warnings.map((w) => ({
    id: String(w._id),
    reason: w.reason,
    related_type: w.relatedType,
    related_id: w.relatedId,
    created_by: w.createdBy ? String(w.createdBy) : null,
    created_at: w.createdAt.toISOString(),
  })),
  disputes: h.disputes.map((d) => ({
    id: String(d._id),
    booking_id: String(d.bookingId),
    status: d.status,
    reason_code: d.reasonCode,
    created_at: d.createdAt.toISOString(),
  })),
  audit_trail: h.auditTrail.map(presentAuditEntry),
});

export const presentAdminBooking = (b: IBooking) => ({
  id: String(b._id),
  reference_code: b.referenceCode,
  status: b.status,
  type: b.type,
  service_name: b.service.nameAr,
  area_name: b.address.areaNameAr,
  patient_user_id: String(b.patientUserId),
  patient_profile_id: String(b.patientProfileId),
  provider_profile_id: b.providerProfileId ? String(b.providerProfileId) : null,
  scheduled_start: b.scheduledStart.toISOString(),
  scheduled_end: b.scheduledEnd.toISOString(),
  total: b.price.total,
  payment_method: b.paymentMethod,
  payment_status: b.paymentStatus,
  created_at: b.createdAt.toISOString(),
});

export const presentAdminBookingDetail = (input: {
  booking: IBooking;
  history: IBookingStatusHistory[];
  offers: IBookingOffer[];
}) => {
  const b = input.booking;
  return {
    booking: {
      ...presentAdminBooking(b),
      address: { area_name: b.address.areaNameAr, full_text: b.address.fullText },
      price: {
        subtotal: b.price.subtotal,
        travel_fee: b.price.travelFee,
        discount: b.price.discount,
        platform_fee: b.price.platformFee,
        commission_amount: b.price.commissionAmount,
        provider_payout: b.price.providerPayout,
        total: b.price.total,
      },
      patient_notes: decryptNullable(b.patientNotes),
      cancellation_reason: b.cancellationReason,
      cancelled_by: b.cancelledBy,
      patient_fee: b.patientFee,
      late_cancellation: b.lateCancellation,
      completed_at: iso(b.completedAt),
    },
    history: input.history.map((h) => ({
      from_status: h.fromStatus,
      to_status: h.toStatus,
      changed_by: h.changedBy ? String(h.changedBy) : null,
      note: h.note,
      at: h.createdAt.toISOString(),
    })),
    offers: input.offers.map((o) => ({
      provider_profile_id: String(o.providerProfileId),
      status: o.status,
      offered_at: o.offeredAt.toISOString(),
      responded_at: iso(o.respondedAt),
    })),
    payments: [] as never[], // card payments: Phase 2
  };
};

export const presentAttention = (a: {
  expiredRequests: IBooking[];
  openDisputes: IDispute[];
  expiringDocuments: IProviderDocument[];
  now: Date;
}) => ({
  expired_requests: a.expiredRequests.map(presentAdminBooking),
  open_disputes: a.openDisputes.map((d) => ({
    id: String(d._id),
    booking_id: String(d.bookingId),
    reason_code: d.reasonCode,
    created_at: d.createdAt.toISOString(),
  })),
  expiring_documents: a.expiringDocuments.map((d) => ({
    id: String(d._id),
    provider_profile_id: String(d.providerProfileId),
    type: d.type,
    expires_at: d.expiresAt!.toISOString(),
    expired: d.expiresAt! <= a.now,
  })),
});
