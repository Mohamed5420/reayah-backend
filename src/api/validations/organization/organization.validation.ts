import { Gender, ProviderType, VerificationStatus } from '../../../interfaces/enums';
import { EGYPT_MOBILE } from '../../../services/auth/auth.constants';
import {
  BookingStatus,
  BookingType,
  PaymentMethod,
  PaymentStatus,
  PreferredGender,
} from '../../../interfaces/IBooking';
import { DocumentReviewStatus } from '../../../interfaces/IProvider';
import {
  OrganizationDocumentType,
  OrganizationType,
  StaffInviteStatus,
} from '../../../interfaces/IOrganization';
import { ProviderSchemas } from '../provider/provider.validation';
import { objectId, paginationQuery, piastres, timestamps, z } from '../zod';

const date = z.iso.date().openapi({ example: '2030-12-31' });

const checklist = z.object({
  info_completed: z.boolean(),
  documents_uploaded: z.boolean(),
  areas_selected: z.boolean(),
  services_set: z.boolean(),
  can_submit: z.boolean(),
});

const document = z
  .object({
    id: objectId,
    type: z.enum(OrganizationDocumentType),
    status: z.enum(DocumentReviewStatus),
    mime: z.string(),
    /** Signed, valid 10 minutes. */
    file_url: z.string(),
    expires_at: z.string().nullable(),
    review_note: z.string().nullable(),
    uploaded_at: z.string(),
  })
  .openapi('OrganizationDocument');

const serviceArea = ProviderSchemas.serviceArea
  .extend({
    is_active: z.boolean(),
    /** Approved staff covering the area and taking bookings (computed). */
    team_size: z.number(),
  })
  .openapi('OrganizationServiceArea');

const fields = {
  name: z.string().trim().min(2).max(120),
  type: z.enum(OrganizationType),
  commercial_register_no: z.string().trim().min(3).max(50),
  tax_id: z.string().trim().min(3).max(50),
  description: z.string().trim().max(2000).nullable(),
  phone: z
    .string()
    .trim()
    .regex(/^\+?\d{7,15}$/, { error: 'validation.phone' })
    .nullable(),
  /** Text only — never coordinates (spec §1). */
  address_text: z.string().trim().max(300).nullable(),
};

const organization = z
  .object({
    id: objectId,
    name: z.string(),
    type: z.enum(OrganizationType),
    commercial_register_no: z.string(),
    tax_id: z.string(),
    description: z.string().nullable(),
    phone: z.string().nullable(),
    address_text: z.string().nullable(),
    /** Signed, valid 10 minutes. */
    logo_url: z.string().nullable(),
    verification_status: z.enum(VerificationStatus),
    rejection_reason: z.string().nullable(),
    admin_message: z.string().nullable(),
    submitted_at: z.string().nullable(),
    reviewed_at: z.string().nullable(),
    onboarding: checklist,
    /** Team invites so far; never-accepted invites are deleted after 30 days but still counted here. */
    invite_stats: z.object({ pending: z.number(), accepted: z.number(), not_accepted: z.number() }),
    ...timestamps,
  })
  .openapi('Organization');

const owner = z.object({ id: objectId, full_name: z.string(), phone: z.string() }).nullable();

/** Spec §7.11 "Organization setup" and §7.15 organizations / verification. */
export const OrganizationSchemas = {
  idParams: z.object({ id: objectId }),
  createBody: z
    .strictObject({
      ...fields,
      description: fields.description.optional(),
      phone: fields.phone.optional(),
      address_text: fields.address_text.optional(),
    })
    .openapi('CreateOrganization'),
  updateBody: z.strictObject(fields).partial().openapi('UpdateOrganization'),
  organization,

  document,
  attachDocumentBody: z
    .strictObject({
      type: z.enum(OrganizationDocumentType),
      /** From POST /uploads with purpose `org_document`. */
      file_key: z.string().min(1).max(300),
      expires_at: date.nullable().optional(),
    })
    .openapi('AttachOrganizationDocument'),

  serviceArea,
  serviceAreasBody: z.strictObject({
    areas: z
      .array(
        z.strictObject({
          area_id: objectId,
          travel_fee: piastres.default(0),
          is_active: z.boolean().default(true),
        }),
      )
      .max(100),
  }),
  service: ProviderSchemas.providerService,
  servicesBody: z.strictObject({
    services: z
      .array(
        z.strictObject({
          service_id: objectId,
          price: piastres.min(1),
          is_active: z.boolean().default(true),
          visit_type: z
            .enum([BookingType.HOME_VISIT, BookingType.CLINIC_VISIT])
            .default(BookingType.HOME_VISIT),
        }),
      )
      .max(100),
  }),

  // Admin
  queueItem: z
    .object({
      id: objectId,
      type: z.literal('organization'),
      name: z.string(),
      phone: z.string(),
      organization_type: z.enum(OrganizationType),
      status: z.enum(VerificationStatus),
      submitted_at: z.string().nullable(),
      documents_count: z.number(),
    })
    .openapi('OrganizationQueueItem'),
  reviewDetail: organization
    .omit({ onboarding: true, invite_stats: true })
    .extend({
      kind: z.literal('organization'),
      owner,
      commission_rate: z.number().nullable(),
      documents: z.array(document),
      service_areas: z.array(serviceArea),
      services: z.array(ProviderSchemas.providerService),
      onboarding: checklist,
    })
    .openapi('OrganizationReviewDetail'),
  adminListQuery: paginationQuery.extend({
    status: z.enum(VerificationStatus).optional(),
    search: z.string().trim().max(100).optional(),
  }),
  adminListItem: z
    .object({
      id: objectId,
      name: z.string(),
      type: z.enum(OrganizationType),
      verification_status: z.enum(VerificationStatus),
      owner,
      commission_rate: z.number().nullable(),
      service_areas_count: z.number(),
      services_count: z.number(),
      created_at: z.string(),
    })
    .openapi('AdminOrganizationListItem'),
  adminUpdateBody: z
    .strictObject({
      name: fields.name,
      type: fields.type,
      description: fields.description,
      phone: fields.phone,
      address_text: fields.address_text,
      /** Percent of the subtotal; null = the platform's commission_rate. */
      commission_rate: z.number().int().min(0).max(100).nullable(),
    })
    .partial()
    .openapi('AdminUpdateOrganization'),
};

const staffStatus = z.enum(['active', 'suspended', 'pending_verification']).openapi({
  description:
    'active = verified and not suspended; suspended by the owner; pending_verification = not approved yet',
});

const staffMember = z
  .object({
    id: objectId,
    user_id: objectId,
    full_name: z.string(),
    phone: z.string(),
    gender: z.enum(Gender).nullable(),
    /** Signed, valid 10 minutes. */
    avatar_url: z.string().nullable(),
    type: z.enum(ProviderType).nullable(),
    status: staffStatus,
    verification_status: z.enum(VerificationStatus),
    is_accepting_bookings: z.boolean(),
    is_online: z.boolean(),
    rating_avg: z.number(),
    completed_visits: z.number(),
    service_area_ids: z.array(objectId),
    service_ids: z.array(objectId),
  })
  .openapi('StaffMember');

/** Team management (spec §7.11 "Dashboard & team", M3.2). */
export const StaffSchemas = {
  idParams: z.object({ id: objectId }),
  inviteBody: z
    .strictObject({
      phone: z.string().trim().regex(EGYPT_MOBILE, { error: 'validation.phone' }),
      full_name: z.string().trim().min(2).max(100),
      type: z.enum(ProviderType),
    })
    .openapi('StaffInviteRequest'),
  invite: z
    .object({
      id: objectId,
      phone: z.string(),
      full_name: z.string(),
      type: z.enum(ProviderType),
      status: z.enum(StaffInviteStatus),
      expires_at: z.string(),
      created_at: z.string(),
    })
    .openapi('StaffInvite'),
  /** What an invitee sees. */
  receivedInvite: z
    .object({
      id: objectId,
      organization_name: z.string(),
      type: z.enum(ProviderType),
      expires_at: z.string(),
    })
    .openapi('ReceivedStaffInvite'),
  listQuery: paginationQuery.extend({
    status: staffStatus.optional(),
    type: z.enum(ProviderType).optional(),
  }),
  member: staffMember,
  detail: staffMember
    .extend({
      services: z.array(ProviderSchemas.providerService),
      service_areas: z.array(ProviderSchemas.serviceArea),
      availability: ProviderSchemas.availability.shape.slots,
      performance: z.object({
        completed_visits: z.number(),
        completed_last_30_days: z.number(),
        rating_avg: z.number(),
        rating_count: z.number(),
        /** Percent of visits started within the grace period; null before the first one. */
        on_time_rate: z.number().nullable(),
      }),
      joined_at: z.string(),
    })
    .openapi('StaffMemberDetail'),
  updateBody: z
    .strictObject({
      status: z.enum(['active', 'suspended']).optional(),
      /** From the organization's services, matching the member's type (nurse / doctor). */
      service_ids: z.array(objectId).max(100).optional(),
    })
    .openapi('UpdateStaffMember'),
  areasBody: z
    .strictObject({ area_ids: z.array(objectId).max(100) })
    .openapi({ description: "Areas from the organization's own list; its travel fee applies." }),
  availabilityBody: ProviderSchemas.availabilityBody,
};

const orgBooking = z
  .object({
    id: objectId,
    reference_code: z.string(),
    status: z.enum(BookingStatus),
    type: z.enum(BookingType),
    service: z.object({ id: objectId, name: z.string() }),
    quantity: z.number(),
    area_name: z.string(),
    scheduled_start: z.string(),
    scheduled_end: z.string(),
    preferred_gender: z.enum(PreferredGender),
    /** Assign (or send to all suitable) before this; afterwards it goes to other providers. */
    assignment_deadline: z.string().nullable(),
    staff: z.object({ id: objectId, name: z.string(), phone: z.string().nullable() }).nullable(),
    price: z.object({
      total: z.number(),
      travel_fee: z.number(),
      /** What the organization earns: subtotal − commission + travel fee. */
      payout: z.number(),
      currency: z.literal('EGP'),
    }),
    payment_method: z.enum(PaymentMethod),
    payment_status: z.enum(PaymentStatus),
    /** Another organization's request offered to this one after its deadline: take it by assigning. */
    offer: z.object({ id: objectId, expires_at: z.string() }).nullable(),
    /**
     * Shown once a staff member is assigned. Never booking notes or medical data — only the assigned staff
     * member sees those (decision).
     */
    patient: z.object({ name: z.string(), phone: z.string().nullable() }).nullable(),
    address: z.object({ area_name: z.string(), full_text: z.string().nullable() }),
    allowed_actions: z.array(z.enum(['assign', 'broadcast', 'reassign', 'decline', 'cancel'])),
  })
  .openapi('OrganizationBooking');

/** Organization bookings, assignment and broadcast (spec §6.6, §7.11 "Bookings", M3.3). */
export const OrgBookingSchemas = {
  idParams: z.object({ id: objectId }),
  listQuery: paginationQuery.extend({
    status: z.enum(BookingStatus).optional(),
    date: z.iso.date().optional(),
    staff_id: objectId.optional(),
  }),
  booking: orgBooking,
  eligibleStaff: z
    .object({
      id: objectId,
      name: z.string(),
      gender: z.enum(Gender).nullable(),
      rating_avg: z.number(),
      available: z.boolean(),
      /** Why not: suspended, not_accepting, area, service, gender, busy. */
      reason: z.string().nullable(),
    })
    .openapi('EligibleStaff'),
  assignBody: z.strictObject({ provider_profile_id: objectId }).openapi('AssignStaff'),
  broadcastResult: z.object({ offered: z.number() }),
  declineBody: z.strictObject({ reason_code: z.enum(['no_staff_available', 'not_in_area', 'other']) }),
  declineResult: z.object({
    status: z.enum(BookingStatus),
    /** true: sent on to other providers (or, for an offer, passed on). */
    passed_on: z.boolean(),
  }),
  cancelBody: z.strictObject({
    reason_code: z.enum(['staff_unavailable', 'emergency', 'patient_request', 'other']),
    reason_text: z.string().trim().max(500).nullable().optional(),
  }),
};

const planView = z
  .object({
    id: objectId,
    key: z.string(),
    name: z.string(),
    /** Piastres a month; 0 = free. */
    monthly_price: z.number(),
    max_staff: z.number(),
    features: z.array(z.string()),
    is_default: z.boolean(),
  })
  .openapi('SubscriptionPlan');

const adminPlan = z
  .object({
    id: objectId,
    key: z.string(),
    name_ar: z.string(),
    name_en: z.string().nullable(),
    monthly_price: z.number(),
    max_staff: z.number(),
    features: z.array(z.object({ ar: z.string(), en: z.string().nullable() })),
    is_active: z.boolean(),
    is_default: z.boolean(),
    sort_order: z.number(),
  })
  .openapi('AdminSubscriptionPlan');

const planBody = z.strictObject({
  key: z
    .string()
    .trim()
    .regex(/^[a-z0-9_]{2,30}$/),
  name_ar: z.string().trim().min(2).max(60),
  name_en: z.string().trim().min(2).max(60).nullable().optional(),
  monthly_price: piastres,
  max_staff: z.number().int().min(1).max(10_000),
  features: z
    .array(z.object({ ar: z.string().trim().min(1).max(120), en: z.string().trim().max(120).nullable() }))
    .max(20)
    .optional(),
  is_active: z.boolean().optional(),
  is_default: z.boolean().optional(),
  sort_order: z.number().int().optional(),
});

const reportNumbers = {
  visits: z.number(),
  /** What patients paid for completed visits (service + travel fee). */
  revenue: z.number(),
};

/** Owner dashboard, reports, statements, finance and plan (spec §7.11, M3.4). */
export const OrgFinanceSchemas = {
  idParams: z.object({ id: objectId }),
  dashboardQuery: z.object({ period: z.enum(['today', 'week', 'month']).default('today') }),
  dashboard: z
    .object({
      period: z.enum(['today', 'week', 'month']),
      bookings: z.object({
        total: z.number(),
        pending: z.number(),
        /** Waiting for the owner to assign, now. */
        unassigned: z.number(),
        in_progress: z.number(),
        completed: z.number(),
        cancelled: z.number(),
      }),
      staff: z.object({ total: z.number(), active_now: z.number() }),
      revenue: z.object({ gross: z.number(), commission: z.number(), net: z.number() }),
      rating_avg: z.number(),
      alerts: z.array(
        z.object({
          type: z.enum(['unassigned_booking', 'offers_available', 'commission_limit']),
          booking_id: objectId.nullable(),
          message: z.string(),
        }),
      ),
    })
    .openapi('OrgDashboard'),
  reportQuery: z.object({
    from: z.iso.date(),
    to: z.iso.date(),
    /** branch: one row per clinic branch, plus one for home visits (clinic visits, C4). */
    group_by: z.enum(['day', 'staff', 'service', 'branch']).default('day'),
  }),
  report: z
    .object({
      period: z.object({ from: z.string(), to: z.string() }),
      summary: z.object({
        ...reportNumbers,
        avg_rating: z.number().nullable(),
        cancellation_rate: z.number().nullable(),
        on_time_rate: z.number().nullable(),
      }),
      rows: z.array(
        z.object({
          /** Date, staff id or service id. */
          key: z.string(),
          label: z.string(),
          ...reportNumbers,
          rating: z.number().nullable(),
          on_time_rate: z.number().nullable(),
        }),
      ),
    })
    .openapi('OrgReport'),
  statement: z
    .object({
      id: objectId,
      period: z.string().openapi({ example: '2026-10' }),
      number: z.string(),
      /** A statement of platform charges — not a tax invoice. */
      kind: z.literal('statement'),
      visits: z.number(),
      commission: z.number(),
      subscription_fees: z.number(),
      subscription_credits: z.number(),
      total: z.number(),
      currency: z.literal('EGP'),
      created_at: z.string(),
    })
    .openapi('OrgStatement'),
  statementPdf: z.object({ url: z.string(), expires_in: z.number() }).openapi('OrgStatementPdf'),
  plan: planView,
  subscription: z
    .object({
      plan: planView,
      /** null on a free plan. */
      period: z.object({ start: z.string(), end: z.string() }).nullable(),
      usage: z.object({ staff: z.number(), pending_invites: z.number(), max_staff: z.number() }),
      /** Plan fees still owed (never counted in the commission limit; never pauses bookings). */
      unpaid: z.object({ amount: z.number(), since: z.string().nullable() }),
    })
    .openapi('OrgSubscription'),
  payPlanFeesBody: z.strictObject({ method: z.enum(['card', 'wallet']) }).openapi('PayPlanFees'),
  subscribeBody: z.strictObject({ plan_id: objectId }).openapi('ChangePlan'),
  adminPlan,
  createPlanBody: planBody.openapi('CreateSubscriptionPlan'),
  updatePlanBody: planBody.partial().openapi('UpdateSubscriptionPlan'),
};
