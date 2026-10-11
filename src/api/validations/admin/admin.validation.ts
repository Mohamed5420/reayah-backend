import { ANALYTICS_GROUPS, ANALYTICS_METRICS } from '../../../services/admin/admin-analytics.service';
import { AdminRole } from '../../../interfaces/enums';
import { Gender, ProviderType, UserRole, UserStatus, VerificationStatus } from '../../../interfaces/enums';
import { BookingStatus, BookingType, PaymentMethod, PaymentStatus } from '../../../interfaces/IBooking';
import { DisputeStatus } from '../../../interfaces/IAftercare';
import { EGYPT_MOBILE } from '../../../services/auth/auth.constants';
import { objectId, specialtyView, z } from '../zod';

const instant = z.iso.datetime({ offset: true }).openapi({ example: '2026-10-05T14:00:00Z' });
const reason = z.string().trim().min(3).max(1000);
const auditEntry = z
  .object({
    id: objectId,
    actor_id: objectId.nullable(),
    action: z.string(),
    entity_type: z.string(),
    entity_id: z.string().nullable(),
    metadata: z.record(z.string(), z.unknown()).nullable(),
    ip: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi('AuditLogEntry');

const adminUser = z
  .object({
    id: objectId,
    phone: z.string(),
    full_name: z.string(),
    email: z.string().nullable(),
    gender: z.enum(Gender).nullable(),
    role: z.enum(UserRole),
    /** Admins only (decision M3.5). */
    admin_role: z.enum(AdminRole).nullable(),
    is_test_account: z.boolean(),
    status: z.enum(UserStatus),
    language: z.string(),
    last_login_at: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi('AdminUser');

const providerSummary = z.object({
  id: objectId,
  type: z.enum(ProviderType).nullable(),
  verification_status: z.enum(VerificationStatus),
  is_accepting_bookings: z.boolean(),
  rating_avg: z.number(),
  rating_count: z.number(),
  completed_visits: z.number(),
});

const adminBooking = z
  .object({
    id: objectId,
    reference_code: z.string(),
    status: z.enum(BookingStatus),
    type: z.enum(BookingType),
    service_name: z.string(),
    area_name: z.string(),
    patient_user_id: objectId,
    patient_profile_id: objectId,
    provider_profile_id: objectId.nullable(),
    scheduled_start: z.string(),
    scheduled_end: z.string(),
    total: z.number(),
    payment_method: z.enum(PaymentMethod),
    payment_status: z.enum(PaymentStatus),
    created_at: z.string(),
  })
  .openapi('AdminBooking');

export const AdminSchemas = {
  idParams: z.object({ id: objectId }),

  // ---- Analytics (M3.5) ----
  analyticsQuery: z.strictObject({
    metric: z.enum(ANALYTICS_METRICS),
    /** Cairo calendar dates, inclusive. Max 92 days by day, 366 by week, ~3 years by month. */
    from: z.iso.date().openapi({ example: '2026-09-01' }),
    to: z.iso.date().openapi({ example: '2026-09-30' }),
    group_by: z.enum(ANALYTICS_GROUPS).default('day'),
    /** Booking metrics only: home_visit or clinic_visit (C5). */
    visit_type: z.enum([BookingType.HOME_VISIT, BookingType.CLINIC_VISIT]).optional(),
  }),
  analytics: z
    .object({
      metric: z.enum(ANALYTICS_METRICS),
      group_by: z.enum(ANALYTICS_GROUPS),
      from: z.string(),
      to: z.string(),
      /** Whole range: a sum, the overall rate (cancellation_rate: 0–1, null without bookings), or distinct providers (active_providers). */
      total: z.number().nullable(),
      /** One point per period, keyed by its first Cairo day (weeks start on Saturday); empty periods are 0 (null for a rate). */
      series: z.array(z.object({ period: z.string(), value: z.number().nullable() })),
    })
    .openapi('AdminAnalytics'),

  // ---- Dashboard ----
  dashboard: z
    .object({
      kpis: z.object({
        bookings_today: z.number(),
        gmv_30d: z.number(),
        revenue_30d: z.number(),
        completed_30d: z.number(),
        active_providers: z.number(),
        pending_verifications: z.number(),
        open_disputes: z.number(),
      }),
      bookings_14d: z.array(z.object({ date: z.string(), count: z.number() })),
      today_by_status: z.record(z.string(), z.number()),
      top_areas: z.array(z.object({ area_name: z.string().nullable(), bookings: z.number() })),
      recent_activity: z.array(auditEntry),
    })
    .openapi('AdminDashboard'),
  attention: z
    .object({
      expired_requests: z.array(adminBooking),
      open_disputes: z.array(
        z.object({ id: objectId, booking_id: objectId, reason_code: z.string(), created_at: z.string() }),
      ),
      expiring_documents: z.array(
        z.object({
          id: objectId,
          provider_profile_id: objectId,
          type: z.string(),
          expires_at: z.string(),
          expired: z.boolean(),
        }),
      ),
      /** Clinic visits confirmed but never started, 2 h after their end (last 7 days). */
      clinic_visits_not_started: z.array(adminBooking),
    })
    .openapi('AdminAttention'),

  // ---- Users ----
  usersQuery: z.object({
    role: z.enum(UserRole).optional(),
    status: z.enum(UserStatus).optional(),
    search: z.string().trim().min(1).max(100).optional(),
  }),
  user: adminUser,
  userDetail: z
    .object({
      user: adminUser,
      provider_profile: providerSummary.nullable(),
      bookings_count: z.number(),
      /** Travel-fee charges on cash bookings (late cancellation / no-show) not collected — repeat cases show here. */
      /**
       * Patients: free late cancellations (accepted, within the free window, before "on the way"), and
       * travel-fee charges (cancelled after "on the way" / no-show) incl. cash ones not collected.
       */
      cancellation_record: z.object({
        late_cancellations: z.number(),
        travel_fee_charges: z.object({
          count: z.number(),
          total: z.number(),
          uncollected: z.object({ count: z.number(), total: z.number() }),
        }),
      }),
    })
    .openapi('AdminUserDetail'),
  suspendBody: z
    .strictObject({
      reason,
      /** `null` = until lifted. */
      duration_days: z.number().int().min(1).max(365).nullable(),
      notify: z.boolean().default(true),
    })
    .openapi('SuspendUserRequest'),
  suspended: z.object({ ends_at: z.string().nullable(), cancelled_bookings: z.number() }),
  warnBody: z
    .strictObject({
      reason,
      related_type: z.enum(['booking', 'dispute', 'review']).nullable().optional(),
      related_id: objectId.nullable().optional(),
      notify: z.boolean().default(true),
    })
    .openapi('WarnUserRequest'),
  warning: z.object({ id: objectId, reason: z.string(), created_at: z.string() }),
  history: z
    .object({
      suspensions: z.array(
        z.object({
          id: objectId,
          reason: z.string(),
          starts_at: z.string(),
          ends_at: z.string().nullable(),
          lifted_at: z.string().nullable(),
          created_by: objectId.nullable(),
        }),
      ),
      warnings: z.array(
        z.object({
          id: objectId,
          reason: z.string(),
          related_type: z.string().nullable(),
          related_id: z.string().nullable(),
          created_by: objectId.nullable(),
          created_at: z.string(),
        }),
      ),
      disputes: z.array(
        z.object({
          id: objectId,
          booking_id: objectId,
          status: z.enum(DisputeStatus),
          reason_code: z.string(),
          created_at: z.string(),
        }),
      ),
      audit_trail: z.array(auditEntry),
    })
    .openapi('AdminUserHistory'),

  // ---- Providers ----
  providersQuery: z.object({
    verification_status: z.enum(VerificationStatus).optional(),
    area_id: objectId.optional(),
    type: z.enum(ProviderType).optional(),
  }),
  providerItem: z
    .object({
      ...providerSummary.shape,
      user: adminUser.pick({ id: true, full_name: true, phone: true, status: true }),
    })
    .openapi('AdminProviderItem'),
  providerDetail: z
    .object({
      ...providerSummary.shape,
      user: adminUser,
      specialty: specialtyView,
      years_of_experience: z.number().nullable(),
      license_number: z.string().nullable(),
      syndicate_number: z.string().nullable(),
      admin_message: z.string().nullable(),
      service_areas: z.array(z.object({ area_id: objectId, travel_fee: z.number() })),
      services: z.array(z.object({ service_id: objectId, price: z.number(), is_active: z.boolean() })),
      bookings_by_status: z.record(z.string(), z.number()),
    })
    .openapi('AdminProviderDetail'),
  providerPatch: z
    .strictObject({
      /** Only approved ⇄ suspended here; other moves go through /admin/verifications. */
      verification_status: z.enum([VerificationStatus.APPROVED, VerificationStatus.SUSPENDED]).optional(),
      admin_message: z.string().trim().max(1000).nullable().optional(),
    })
    .openapi('AdminProviderPatch'),

  // ---- Admin accounts ----
  adminCreateBody: z
    .strictObject({
      phone: z.string().trim().regex(EGYPT_MOBILE, { error: 'validation.phone' }),
      full_name: z.string().trim().min(2).max(100),
      admin_role: z.enum(AdminRole),
    })
    .openapi('CreateAdminRequest'),
  adminPatch: z
    .strictObject({
      status: z.enum([UserStatus.ACTIVE, UserStatus.SUSPENDED]).optional(),
      /** Change the sub-role. */
      admin_role: z.enum(AdminRole).optional(),
    })
    .openapi('AdminAccountPatch'),

  // ---- Bookings ----
  bookingsQuery: z.object({
    status: z.enum(BookingStatus).optional(),
    date_from: instant.optional(),
    date_to: instant.optional(),
    area_id: objectId.optional(),
    /** Reference code, or part of it. */
    search: z.string().trim().min(2).max(20).optional(),
    /** home_visit or clinic_visit (C5). */
    visit_type: z.enum([BookingType.HOME_VISIT, BookingType.CLINIC_VISIT]).optional(),
  }),
  booking: adminBooking,
  bookingDetail: z
    .object({
      booking: adminBooking.extend({
        address: z.object({ area_name: z.string(), full_text: z.string() }),
        price: z.object({
          subtotal: z.number(),
          travel_fee: z.number(),
          discount: z.number(),
          platform_fee: z.number(),
          commission_amount: z.number(),
          provider_payout: z.number(),
          total: z.number(),
        }),
        /** Decrypted; every view is audited. */
        patient_notes: z.string().nullable(),
        cancellation_reason: z.object({ code: z.string(), text: z.string().nullable() }).nullable(),
        cancelled_by: z.string().nullable(),
        /** Travel-fee charge for a late cancellation / no-show; collected = kept from a card refund. */
        patient_fee: z
          .object({
            amount: z.number(),
            reason: z.enum(['late_cancellation', 'no_show']),
            collected: z.boolean(),
          })
          .nullable(),
        late_cancellation: z.boolean(),
        completed_at: z.string().nullable(),
      }),
      history: z.array(
        z.object({
          from_status: z.string().nullable(),
          to_status: z.string(),
          changed_by: objectId.nullable(),
          note: z.string().nullable(),
          at: z.string(),
        }),
      ),
      offers: z.array(
        z.object({
          provider_profile_id: objectId,
          status: z.string(),
          offered_at: z.string(),
          responded_at: z.string().nullable(),
        }),
      ),
      /** Phase 2 (card payments). */
      payments: z.array(z.object({})),
    })
    .openapi('AdminBookingDetail'),
  forceStatusBody: z
    .strictObject({
      status: z.enum([BookingStatus.CANCELLED, BookingStatus.NO_SHOW, BookingStatus.COMPLETED]),
      note: z.string().trim().max(500).nullable().optional(),
    })
    .openapi('ForceBookingStatusRequest'),
  reassignBody: z.strictObject({ provider_profile_id: objectId }).openapi('ReassignBookingRequest'),

  // ---- System ----
  settings: z.record(z.string(), z.unknown()).openapi('AdminSettings'),
  settingsBody: z.record(z.string(), z.unknown()).openapi('AdminSettingsUpdate'),
  auditQuery: z.object({
    actor_id: objectId.optional(),
    entity_type: z.string().trim().max(50).optional(),
    entity_id: z.string().trim().max(50).optional(),
    action: z.string().trim().max(80).optional(),
  }),
  auditEntry,
};
