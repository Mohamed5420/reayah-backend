import { Gender, PricingUnit, ProviderType, VerificationStatus } from '../../../interfaces/enums';
import { DocumentReviewStatus, ProviderDocumentType } from '../../../interfaces/IProvider';
import { objectId, paginationQuery, piastres, z } from '../zod';

const time = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
  .openapi({ example: '09:00' });
/** `YYYY-MM-DD` (document expiry). */
const date = z.iso.date().openapi({ example: '2027-12-31' });
const dateTime = z.iso.datetime({ offset: true }).openapi({ example: '2026-10-10T00:00:00Z' });

const onboarding = z.object({
  profile_completed: z.boolean(),
  documents_uploaded: z.boolean(),
  areas_selected: z.boolean(),
  services_set: z.boolean(),
  availability_set: z.boolean(),
  can_submit: z.boolean(),
});

const providerProfile = z
  .object({
    id: objectId,
    type: z.enum(ProviderType).nullable(),
    specialty: z.string().nullable(),
    years_of_experience: z.number().nullable(),
    bio: z.string().nullable(),
    languages: z.array(z.string()),
    license_number: z.string().nullable(),
    syndicate_number: z.string().nullable(),
    verification_status: z.enum(VerificationStatus),
    is_accepting_bookings: z.boolean(),
    organization: z.null(),
    rating_avg: z.number(),
    rating_count: z.number(),
    completed_visits: z.number(),
    onboarding,
  })
  .openapi('ProviderProfile');

const document = z
  .object({
    id: objectId,
    type: z.enum(ProviderDocumentType),
    status: z.enum(DocumentReviewStatus),
    mime: z.string(),
    /** Signed, valid 10 minutes. */
    file_url: z.string(),
    expires_at: z.string().nullable(),
    review_note: z.string().nullable(),
    uploaded_at: z.string(),
  })
  .openapi('ProviderDocument');

const serviceArea = z
  .object({
    area_id: objectId,
    name: z.string(),
    governorate_name: z.string(),
    travel_fee: z.number(),
    /** The area's admin cap, if any. */
    max_travel_fee: z.number().nullable(),
    /** false once the area has been deactivated. */
    is_bookable: z.boolean(),
  })
  .openapi('ProviderServiceArea');

const providerService = z
  .object({
    service_id: objectId,
    name: z.string(),
    pricing_unit: z.enum(PricingUnit),
    price: z.number(),
    is_active: z.boolean(),
    min_price: z.number().nullable(),
    max_price: z.number().nullable(),
    /** false once the admin has deactivated the service. */
    is_available: z.boolean(),
  })
  .openapi('ProviderService');

const slot = z
  .object({
    day_of_week: z.number().int().min(0).max(6).openapi({ description: '0 = Sunday' }),
    start_time: time,
    end_time: time,
  })
  .refine((s) => s.end_time > s.start_time, { error: 'validation.ends_before_starts', path: ['end_time'] });

const verificationStatus = z
  .object({
    status: z.enum(VerificationStatus),
    rejection_reason: z.string().nullable(),
    admin_message: z.string().nullable(),
    submitted_at: z.string().nullable(),
    reviewed_at: z.string().nullable(),
    documents: z.array(
      z.object({
        id: objectId,
        type: z.enum(ProviderDocumentType),
        status: z.enum(DocumentReviewStatus),
        review_note: z.string().nullable(),
      }),
    ),
  })
  .openapi('VerificationStatus');

/** Request and response schemas for /provider and /admin/verifications (spec §7.10, §7.15). */
export const ProviderSchemas = {
  idParams: z.object({ id: objectId }),

  // ── Profile & documents ──
  providerProfile,
  updateProfileBody: z
    .object({
      type: z.enum(ProviderType),
      specialty: z.string().trim().max(100).nullable(),
      years_of_experience: z.number().int().min(0).max(60),
      bio: z.string().trim().max(1000).nullable(),
      languages: z.array(z.enum(['ar', 'en', 'fr', 'de'])).max(4),
      license_number: z.string().trim().min(3).max(50),
      syndicate_number: z.string().trim().min(3).max(50),
    })
    .partial()
    .openapi('UpdateProviderProfile'),
  document,
  attachDocumentBody: z
    .object({
      type: z.enum(ProviderDocumentType),
      file_key: z.string().min(1).max(300),
      expires_at: date.nullable().optional(),
    })
    .openapi('AttachProviderDocument'),
  verificationStatus,

  // ── Coverage, services, schedule ──
  serviceArea,
  serviceAreasBody: z.object({
    areas: z.array(z.object({ area_id: objectId, travel_fee: piastres.default(0) })).max(50),
  }),
  providerService,
  servicesBody: z.object({
    services: z
      .array(z.object({ service_id: objectId, price: piastres.min(1), is_active: z.boolean().default(true) }))
      .max(50),
  }),
  availability: z.object({ slots: z.array(slot) }).openapi('Availability'),
  availabilityBody: z.object({ slots: z.array(slot).max(50) }),
  timeOff: z
    .object({ id: objectId, starts_at: z.string(), ends_at: z.string(), reason: z.string().nullable() })
    .openapi('TimeOff'),
  timeOffBody: z.object({
    starts_at: dateTime,
    ends_at: dateTime,
    reason: z.string().trim().max(200).nullable().optional(),
  }),
  acceptingBody: z.object({ is_accepting_bookings: z.boolean() }),

  // ── Admin verification ──
  queueQuery: paginationQuery.extend({
    type: z.enum(['provider', 'organization']).default('provider'),
    status: z.enum(VerificationStatus).default(VerificationStatus.PENDING),
  }),
  queueItem: z
    .object({
      id: objectId,
      type: z.literal('provider'),
      name: z.string(),
      phone: z.string(),
      provider_type: z.enum(ProviderType).nullable(),
      status: z.enum(VerificationStatus),
      submitted_at: z.string().nullable(),
      documents_count: z.number(),
    })
    .openapi('VerificationQueueItem'),
  reviewDetail: providerProfile
    .omit({ onboarding: true })
    .extend({
      user: z.object({
        id: objectId,
        full_name: z.string(),
        phone: z.string(),
        gender: z.enum(Gender).nullable(),
        date_of_birth: z.string().nullable(),
      }),
      submitted_at: z.string().nullable(),
      rejection_reason: z.string().nullable(),
      admin_message: z.string().nullable(),
      documents: z.array(document),
      service_areas: z.array(serviceArea),
      services: z.array(providerService),
      availability: z.array(slot),
      onboarding,
    })
    .openapi('VerificationDetail'),
  requestChangesBody: z.object({
    message: z.string().trim().min(1).max(1000),
    documents: z.array(z.enum(ProviderDocumentType)).default([]),
  }),
  rejectBody: z.object({
    reason: z.string().trim().min(1).max(1000),
    documents: z.array(z.enum(ProviderDocumentType)).default([]),
  }),
  documentReviewBody: z.object({
    status: z.enum([DocumentReviewStatus.MATCHING, DocumentReviewStatus.NOT_MATCHING]),
    note: z.string().trim().max(1000).nullable().optional(),
    expires_at: date.nullable().optional(),
  }),
};
