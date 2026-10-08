/** Enums shared with the frontend (spec §7.0 "Enums"). Values are part of the API contract. */

export enum UserRole {
  PATIENT = 'patient',
  PROVIDER = 'provider',
  PROVIDER_STAFF = 'provider_staff',
  OWNER = 'owner',
  ADMIN = 'admin',
  /** Branch reception (clinic visits, C4): today's appointments at one branch, check-in, no-show. */
  RECEPTION = 'reception',
}

/**
 * Admin sub-roles (spec §7.15; decision M3.5). super_admin: everything; verifier: verification;
 * support: users, bookings, disputes, reviews, booking chats; finance: payments, refunds, payouts, dues,
 * adjustments, exports; marketing: promo codes, banners, packages, marketing pushes.
 */
export enum AdminRole {
  SUPER_ADMIN = 'super_admin',
  VERIFIER = 'verifier',
  SUPPORT = 'support',
  FINANCE = 'finance',
  MARKETING = 'marketing',
}

/** Roles a user can pick at `/auth/register`. Staff join via an organization invite; admins via `npm run admin:create`. */
export const SELF_REGISTER_ROLES = [UserRole.PATIENT, UserRole.PROVIDER, UserRole.OWNER] as const;

export enum UserStatus {
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
  DELETED = 'deleted',
}

export enum Gender {
  MALE = 'male',
  FEMALE = 'female',
}

export enum DevicePlatform {
  IOS = 'ios',
  ANDROID = 'android',
  WEB = 'web',
}

export enum ProviderType {
  NURSE = 'nurse',
  DOCTOR = 'doctor',
}

export enum VerificationStatus {
  DRAFT = 'draft',
  PENDING = 'pending',
  CHANGES_REQUESTED = 'changes_requested',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  SUSPENDED = 'suspended',
}

export enum Relation {
  SELF = 'self',
  FATHER = 'father',
  MOTHER = 'mother',
  CHILD = 'child',
  SPOUSE = 'spouse',
  SIBLING = 'sibling',
  OTHER = 'other',
}

export enum PricingUnit {
  PER_VISIT = 'per_visit',
  PER_HOUR = 'per_hour',
  PER_DAY = 'per_day',
}
