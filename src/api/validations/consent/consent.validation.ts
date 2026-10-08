import { UserRole } from '../../../interfaces/enums';
import { ConsentKind } from '../../../interfaces/IConsent';
import { z } from '../zod';

const kind = z.enum(ConsentKind);
const version = z.number().int().min(1);
const consentRoles = z.enum([
  UserRole.PATIENT,
  UserRole.PROVIDER,
  UserRole.PROVIDER_STAFF,
  UserRole.OWNER,
  UserRole.RECEPTION,
]);

export const ConsentSchemas = {
  /** Sign-up: the current version of every text the role must accept (GET /consent-documents?role=). */
  signupConsents: z.array(z.strictObject({ kind, version })).max(10),

  documentsQuery: z.object({ role: consentRoles.optional() }),
  document: z
    .object({
      kind,
      version: z.number(),
      title: z.string(),
      body: z.string(),
      url: z.string().nullable(),
      /** Roles that must accept it. */
      roles: z.array(z.string()),
      published_at: z.string(),
    })
    .openapi('ConsentDocument'),

  status: z
    .object({
      kind,
      current_version: z.number(),
      title: z.string(),
      accepted_version: z.number().nullable(),
      accepted_at: z.string().nullable(),
      withdrawn_at: z.string().nullable(),
      /** false → show the current text and ask again. */
      up_to_date: z.boolean(),
    })
    .openapi('ConsentStatus'),
  recordBody: z
    .strictObject({
      consents: z
        .array(z.strictObject({ kind, version, accepted: z.boolean() }))
        .min(1)
        .max(10),
    })
    .openapi('ConsentRecordRequest'),

  adminDocument: z
    .object({
      id: z.string(),
      kind,
      version: z.number(),
      title_ar: z.string(),
      title_en: z.string().nullable(),
      body_ar: z.string(),
      body_en: z.string().nullable(),
      url: z.string().nullable(),
      roles: z.array(z.string()),
      published_by: z.string().nullable(),
      published_at: z.string(),
    })
    .openapi('AdminConsentDocument'),
  publishBody: z
    .strictObject({
      kind,
      title_ar: z.string().trim().min(2).max(200),
      title_en: z.string().trim().max(200).nullable().optional(),
      body_ar: z.string().trim().min(10).max(100_000),
      body_en: z.string().trim().max(100_000).nullable().optional(),
      url: z
        .url({ protocol: /^https$/ })
        .nullable()
        .optional(),
      /** Default: terms / privacy → every non-admin role; health_data → patients. */
      roles: z.array(consentRoles).min(1).optional(),
    })
    .openapi('PublishConsentDocument'),
};
