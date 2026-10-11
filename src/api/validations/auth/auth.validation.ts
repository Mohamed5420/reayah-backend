import { ConsentSchemas } from '../consent/consent.validation';
import { OrganizationType } from '../../../interfaces/IOrganization';
import { EGYPT_MOBILE, OTP } from '../../../services/auth/auth.constants';
import {
  DevicePlatform,
  Gender,
  ProviderType,
  SELF_REGISTER_ROLES,
  UserRole,
  UserStatus,
  VerificationStatus,
} from '../../../interfaces/enums';
import { SUPPORTED_LANGUAGES } from '../../../utils/i18n';
import { objectId, z } from '../zod';

const phone = z
  .string()
  .trim()
  .regex(EGYPT_MOBILE, { error: 'validation.phone' })
  .openapi({ example: '+201001234567' });
const otpCode = z
  .string()
  .regex(new RegExp(`^\\d{${OTP.LENGTH}}$`))
  .openapi({ example: '4821' });
const language = z.enum(SUPPORTED_LANGUAGES);
export const fullName = z.string().trim().min(2).max(100).openapi({ example: 'أحمد محمود' });
/** `YYYY-MM-DD`, in the past. */
export const dateOfBirth = z.iso
  .date()
  .refine((d) => d >= '1900-01-01' && d < new Date().toISOString().slice(0, 10), {
    error: 'validation.date_of_birth',
  })
  .openapi({ example: '1985-03-12' });

const tokens = {
  access_token: z.string(),
  refresh_token: z.string(),
  expires_in: z.number().openapi({ example: 3600 }),
};

const authUser = z
  .object({ id: objectId, full_name: z.string(), role: z.enum(UserRole), language })
  .openapi('AuthUser');

const me = z
  .object({
    id: objectId,
    phone: z.string(),
    full_name: z.string(),
    email: z.string().nullable(),
    gender: z.enum(Gender).nullable(),
    date_of_birth: z.string().nullable(),
    role: z.enum(UserRole),
    language,
    avatar_url: z.string().nullable(),
    status: z.enum(UserStatus),
    provider_profile: z
      .object({
        id: objectId,
        type: z.string().nullable(),
        verification_status: z.enum(VerificationStatus),
        is_accepting_bookings: z.boolean(),
      })
      .nullable(),
    /** Owners: their organization (null until created with POST /org). */
    organization: z
      .object({
        id: objectId,
        name: z.string(),
        type: z.enum(OrganizationType),
        verification_status: z.enum(VerificationStatus),
      })
      .nullable(),
    /** Reception: the organization and the one branch they work at (null for other roles). */
    reception: z
      .object({
        organization: z.object({ id: objectId, name: z.string() }),
        branch: z.object({ id: objectId, name: z.string() }),
      })
      .nullable(),
    unread_notifications: z.number(),
  })
  .openapi('Me');

/** Request and response schemas for /auth and /me (spec §7.1, §7.2). */
export const AuthSchemas = {
  otpRequestBody: z.object({ phone }).openapi('OtpRequest'),
  otpSent: z.object({ expires_in: z.number(), resend_after: z.number() }).openapi('OtpSent'),

  otpVerifyBody: z.object({ phone, code: otpCode }).openapi('OtpVerify'),
  otpVerified: z
    .union([
      z.object({ is_new_user: z.literal(false), ...tokens, user: authUser }),
      z.object({
        is_new_user: z.literal(true),
        registration_token: z.string(),
        /** Organizations that invited this number: register with role provider_staff + staff_invite_id to join. */
        staff_invites: z.array(
          z.object({
            id: objectId,
            organization_name: z.string(),
            /** staff: register as provider_staff; reception: register as reception (one branch). */
            kind: z.enum(['staff', 'reception']),
            /** Staff: nurse or doctor; reception: null. */
            type: z.enum(ProviderType).nullable(),
          }),
        ),
      }),
    ])
    .openapi('OtpVerified'),

  registerBody: z
    .object({
      /** provider_staff only together with staff_invite_id (from the OTP verify response). */
      role: z.enum([...SELF_REGISTER_ROLES, UserRole.PROVIDER_STAFF, UserRole.RECEPTION]),
      full_name: fullName,
      gender: z.enum(Gender),
      date_of_birth: dateOfBirth,
      email: z.email().nullable().optional(),
      language: language.optional(),
      referral_code: z.string().trim().max(32).optional(),
      /** Join an organization that invited this number. */
      staff_invite_id: objectId.optional(),
      /**
       * The current consent texts the role must accept (GET /consent-documents?role=…). Required once
       * any are published; until then it may be omitted.
       */
      consents: ConsentSchemas.signupConsents.optional(),
    })
    .refine(
      (b) => [UserRole.PROVIDER_STAFF, UserRole.RECEPTION].includes(b.role) === Boolean(b.staff_invite_id),
      {
        error: 'validation.staff_invite_required',
        path: ['staff_invite_id'],
      },
    )
    .openapi('Register'),
  session: z.object({ ...tokens, user: authUser }).openapi('Session'),

  refreshBody: z.object({ refresh_token: z.string().min(1) }),
  tokens: z.object(tokens).openapi('Tokens'),
  logoutBody: z.object({ refresh_token: z.string().min(1), fcm_token: z.string().optional() }),

  phoneChangeRequestBody: z.object({ new_phone: phone }),
  phoneChangeVerifyBody: z.object({ new_phone: phone, code: otpCode }),

  // ── /me ──
  me,
  updateMeBody: z
    .object({
      full_name: fullName,
      email: z.email().nullable(),
      gender: z.enum(Gender),
      date_of_birth: dateOfBirth,
      language,
    })
    .partial()
    .openapi('UpdateMe'),
  deleteMeBody: z.object({ reason: z.string().trim().max(500).optional() }),
  accountDeleted: z.object({ status: z.literal(UserStatus.DELETED), deletion_requested_at: z.string() }),
  deviceBody: z
    .object({
      fcm_token: z.string().min(1).max(4096),
      platform: z.enum(DevicePlatform),
      app_version: z.string().max(32).optional(),
    })
    .openapi('RegisterDevice'),
  deviceParams: z.object({ fcm_token: z.string().min(1).max(4096) }),
};

/** `YYYY-MM-DD` → UTC midnight. */
export const parseDateOnly = (value: string) => new Date(`${value}T00:00:00.000Z`);
