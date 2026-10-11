import { SPECIALTY_KEYS } from '../../../services/catalog/specialties';
import { Gender, PricingUnit, ProviderType, VerificationStatus } from '../../../interfaces/enums';
import { DocumentReviewStatus, ProviderDocumentType } from '../../../interfaces/IProvider';
import { objectId, paginationQuery, piastres, z, specialtyView } from '../zod';
import { BookingType } from '../../../interfaces/IBooking';

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
  /** Only matters for doctors who price clinic visits: a clinic with a licence and hours. */
  clinics_set: z.boolean(),
  can_submit: z.boolean(),
});

const providerProfile = z
  .object({
    id: objectId,
    type: z.enum(ProviderType).nullable(),
    specialty: specialtyView,
    years_of_experience: z.number().nullable(),
    bio: z.string().nullable(),
    languages: z.array(z.string()),
    license_number: z.string().nullable(),
    syndicate_number: z.string().nullable(),
    verification_status: z.enum(VerificationStatus),
    is_accepting_bookings: z.boolean(),
    /** A pause set with resumes_at: when accepting turns back on by itself; null otherwise. */
    accepting_resumes_at: z.string().nullable(),
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
    /** The back of a card, when uploaded (signed, 10 minutes); null otherwise. */
    back_file_url: z.string().nullable(),
    back_mime: z.string().nullable(),
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
    /** home_visit or clinic_visit (one entry per visit type). */
    visit_type: z.string(),
    price: z.number(),
    is_active: z.boolean(),
    /** Admin bounds for this visit type. */
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
      /** Doctors only (required for them); keys from GET /specialties. */
      specialty: z.enum(SPECIALTY_KEYS).nullable(),
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
      /** The document, or the front of a card (POST /uploads, purpose provider_document). */
      file_key: z.string().min(1).max(300),
      /** Optional back of a card, uploaded the same way. Not for national_id_front / national_id_back. */
      back_file_key: z.string().min(1).max(300).nullable().optional(),
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
      .array(
        z.object({
          service_id: objectId,
          price: piastres.min(1),
          is_active: z.boolean().default(true),
          /** Doctors may price a service as a clinic visit too (one entry per visit type). */
          visit_type: z
            .enum([BookingType.HOME_VISIT, BookingType.CLINIC_VISIT])
            .default(BookingType.HOME_VISIT),
        }),
      )
      .max(50),
  }),
  availability: z
    .object({
      slots: z.array(slot),
      /** Minutes kept free before and after each home visit (travel between patients). */
      break_minutes: z.number().int(),
      /** Home visits per day at most; null = no limit. */
      max_visits_per_day: z.number().int().nullable(),
    })
    .openapi('Availability'),
  /** Unknown fields → 422 by name. Omitted break_minutes / max_visits_per_day keep their current values. */
  availabilityBody: z.strictObject({
    slots: z.array(slot).max(50),
    break_minutes: z.number().int().min(0).max(120).optional(),
    max_visits_per_day: z.number().int().min(1).max(20).nullable().optional(),
  }),
  timeOff: z
    .object({ id: objectId, starts_at: z.string(), ends_at: z.string(), reason: z.string().nullable() })
    .openapi('TimeOff'),
  timeOffBody: z.object({
    starts_at: dateTime,
    ends_at: dateTime,
    reason: z.string().trim().max(200).nullable().optional(),
  }),
  acceptingBody: z.strictObject({
    is_accepting_bookings: z.boolean(),
    /**
     * With is_accepting_bookings=false: turn accepting back on by itself — an ISO time (future, at most 7
     * days ahead) or "end_of_day" (the next midnight, Cairo time). Omit or null: paused until turned on.
     */
    resumes_at: z
      .union([z.literal('end_of_day'), z.iso.datetime({ offset: true })])
      .nullable()
      .optional(),
  }),

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

/** Weekly hours entry (Cairo "HH:mm"), shared with clinic hours. */
export { slot as weeklySlot };
