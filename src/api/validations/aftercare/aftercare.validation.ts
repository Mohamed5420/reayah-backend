import { ProviderType } from '../../../interfaces/enums';
import {
  DisputeResolution,
  DisputeStatus,
  ProviderAction,
  RefundBearer,
} from '../../../interfaces/IAftercare';
import { objectId, z } from '../zod';

/** Upload keys from POST /uploads (`tmp/...`), or keys already on the record when editing. */
const fileKeys = z.array(z.string().trim().min(1).max(300)).max(10);

const REVIEW_TAGS = ['punctual', 'professional', 'gentle', 'clean', 'friendly', 'explains_well'] as const;
export const DISPUTE_REASONS = [
  'no_show',
  'late',
  'unprofessional',
  'wrong_price',
  'service_quality',
  'other',
] as const;

const vitals = z
  .strictObject({
    bp: z
      .string()
      .regex(/^\d{2,3}\/\d{2,3}$/)
      .optional()
      .openapi({ example: '130/85' }),
    pulse: z.number().int().min(20).max(250).optional(),
    temp: z.number().min(30).max(45).optional(),
    sugar: z.number().int().min(10).max(1000).optional(),
    spo2: z.number().int().min(50).max(100).optional(),
  })
  .openapi('Vitals');

const reportFields = {
  summary: z.string().trim().min(2).max(2000),
  vitals: vitals.nullable().optional(),
  procedures_done: z.array(z.string().trim().min(1).max(200)).max(30).optional(),
  recommendations: z.string().trim().max(2000).nullable().optional(),
  attachments: fileKeys.optional(),
};

const visitReport = z
  .object({
    id: objectId,
    booking_id: objectId,
    date: z.string(),
    provider: z.object({ id: objectId, name: z.string(), type: z.enum(ProviderType).nullable() }).nullable(),
    summary: z.string(),
    vitals: vitals.nullable(),
    procedures_done: z.array(z.string()),
    recommendations: z.string().nullable(),
    attachments: z.array(z.object({ file_url: z.string(), mime: z.string() })),
  })
  .openapi('VisitReport');

export const AftercareSchemas = {
  reviewBody: z
    .strictObject({
      rating: z.number().int().min(1).max(5),
      comment: z.string().trim().max(1000).nullable().optional(),
      tags: z.array(z.enum(REVIEW_TAGS)).max(REVIEW_TAGS.length).optional(),
    })
    .openapi('ReviewRequest'),

  /** The patient's own review, as created. */
  review: z
    .object({
      id: objectId,
      booking_id: objectId,
      rating: z.number(),
      comment: z.string().nullable(),
      tags: z.array(z.string()),
      created_at: z.string(),
    })
    .openapi('Review'),

  /** GET /provider/reviews — visible reviews of the caller. */
  providerReview: z
    .object({
      id: objectId,
      booking_id: objectId,
      rating: z.number(),
      comment: z.string().nullable(),
      tags: z.array(z.string()),
      patient_name: z.string(),
      date: z.string(),
    })
    .openapi('ProviderOwnReview'),

  disputeBody: z
    .strictObject({
      reason_code: z.enum(DISPUTE_REASONS),
      description: z.string().trim().max(2000).nullable().optional(),
      attachments: fileKeys.optional(),
    })
    .openapi('DisputeRequest'),

  dispute: z
    .object({
      id: objectId,
      booking_id: objectId,
      status: z.enum(DisputeStatus),
      reason_code: z.string(),
      description: z.string().nullable(),
      created_at: z.string(),
    })
    .openapi('Dispute'),

  reportBody: z.strictObject(reportFields).openapi('VisitReportRequest'),
  reportPatch: z
    .strictObject({
      summary: reportFields.summary.optional(),
      vitals: reportFields.vitals,
      procedures_done: reportFields.procedures_done,
      recommendations: reportFields.recommendations,
      attachments: reportFields.attachments,
    })
    .openapi('VisitReportPatch'),

  visitReport,
  visitReportItem: z
    .object({
      id: objectId,
      booking_id: objectId,
      date: z.string(),
      provider: z
        .object({ id: objectId, name: z.string(), type: z.enum(ProviderType).nullable() })
        .nullable(),
      summary: z.string(),
    })
    .openapi('VisitReportListItem'),

  reportParams: z.object({ id: objectId, rid: objectId }),

  // ---- Admin ----
  adminDisputesQuery: z.object({ status: z.enum(DisputeStatus).optional() }),
  resolveBody: z
    .strictObject({
      resolution: z.enum(DisputeResolution),
      refund_amount: z.number().int().min(0).optional(),
      /** Who pays the refund; default provider when warned / suspended, else platform. */
      refund_bearer: z.enum(RefundBearer).optional(),
      /** With refund_bearer = split: the provider's part (piastres, ≤ refund_amount). */
      provider_share: z.number().int().min(0).optional(),
      provider_action: z.enum(ProviderAction).default(ProviderAction.NONE),
      /** `null` / omitted with `suspend` = until lifted. */
      suspend_days: z.number().int().min(1).max(365).nullable().optional(),
      message_to_patient: z.string().trim().max(1000).nullable().optional(),
      message_to_provider: z.string().trim().max(1000).nullable().optional(),
    })
    .openapi('ResolveDisputeRequest'),
  adminDispute: z
    .object({
      id: objectId,
      booking_id: objectId,
      booking_reference: z.string().nullable(),
      patient_user_id: objectId,
      provider_profile_id: objectId.nullable(),
      status: z.enum(DisputeStatus),
      reason_code: z.string(),
      description: z.string().nullable(),
      attachments: z.array(z.object({ file_url: z.string() })),
      resolution: z
        .object({
          type: z.enum(DisputeResolution),
          refund_amount: z.number(),
          refund_bearer: z.enum(RefundBearer),
          /** Deducted from the provider (ledger debit); the rest is the platform's cost. */
          provider_share: z.number(),
          provider_action: z.enum(ProviderAction),
          suspend_days: z.number().nullable(),
          message_to_patient: z.string().nullable(),
          message_to_provider: z.string().nullable(),
          resolved_by: objectId,
          resolved_at: z.string(),
        })
        .nullable(),
      created_at: z.string(),
    })
    .openapi('AdminDispute'),

  adminReviewsQuery: z.object({
    flagged: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
    provider_profile_id: objectId.optional(),
  }),
  moderateBody: z
    .strictObject({
      is_visible: z.boolean().optional(),
      /** Replaces phone numbers / emails / links in the comment with `***` (the original is kept). */
      mask_contact: z.literal(true).optional(),
    })
    .refine((b) => b.is_visible !== undefined || b.mask_contact !== undefined, {
      error: 'validation.required',
    })
    .openapi('ModerateReviewRequest'),
  adminReview: z
    .object({
      id: objectId,
      booking_id: objectId,
      provider_profile_id: objectId,
      patient_user_id: objectId,
      patient_name: z.string(),
      rating: z.number(),
      comment: z.string().nullable(),
      original_comment: z.string().nullable(),
      tags: z.array(z.string()),
      is_visible: z.boolean(),
      flagged: z.boolean(),
      created_at: z.string(),
    })
    .openapi('AdminReview'),
};
