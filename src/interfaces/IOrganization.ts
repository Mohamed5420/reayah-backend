import type { Types } from 'mongoose';
import type { ProviderType, VerificationStatus } from './enums';
import type { DocumentReviewStatus } from './IProvider';

/** Spec §4.4 `organizations.type`. */
export enum OrganizationType {
  NURSING_CENTER = 'nursing_center',
  CLINIC = 'clinic',
  LAB = 'lab',
  ELDERLY_CARE = 'elderly_care',
  OTHER = 'other',
}

export enum OrganizationDocumentType {
  COMMERCIAL_REGISTER = 'commercial_register',
  TAX_CARD = 'tax_card',
}

/** Both are needed before an organization can submit for verification. */
export const REQUIRED_ORGANIZATION_DOCUMENTS = [
  OrganizationDocumentType.COMMERCIAL_REGISTER,
  OrganizationDocumentType.TAX_CARD,
];

/**
 * Spec §4.4 `organizations` (service owners) + `organization_service_areas` + the organization's
 * `provider_services` rows, embedded like a provider's. Verification follows the provider flow:
 * draft → pending → approved / changes_requested / rejected.
 */
export interface IOrganization {
  _id: Types.ObjectId;
  ownerUserId: Types.ObjectId;
  name: string;
  type: OrganizationType;
  commercialRegisterNo: string;
  taxId: string;
  description: string | null;
  /** Contact number shown to the admin team (the owner logs in with their own phone). */
  phone: string | null;
  /** Free-text business address — text only, never coordinates (spec §1). */
  addressText: string | null;
  logoKey: string | null;
  verificationStatus: VerificationStatus;
  rejectionReason: string | null;
  adminMessage: string | null;
  submittedAt: Date | null;
  reviewedBy: Types.ObjectId | null;
  reviewedAt: Date | null;
  /** Areas served with the organization's travel fee there (spec §4.4 `organization_service_areas`). */
  serviceAreas: Array<{ areaId: Types.ObjectId; travelFee: number; isActive: boolean }>;
  /** Services and the organization's prices (spec §4.5 `provider_services` with `organization_id`). */
  services: Array<{ serviceId: Types.ObjectId; price: number; isActive: boolean }>;
  /** Admin override of `commission_rate` for this organization (percent); null = the platform rate. */
  commissionRate: number | null;
  /** Spec §4.4: the chosen plan (null = the default free plan). */
  subscriptionPlanId: Types.ObjectId | null;
  /** Current paid period; null on a free plan. */
  subscriptionPeriod: { start: Date; end: Date } | null;
  /** Invites never accepted and since deleted (number and name gone): only this count is kept. */
  lapsedInvitesCount: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Spec §7.11 `/org/documents`: commercial register and tax card. */
export interface IOrganizationDocument {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  type: OrganizationDocumentType;
  fileKey: string;
  mime: string;
  status: DocumentReviewStatus;
  expiresAt: Date | null;
  reviewedBy: Types.ObjectId | null;
  reviewedAt: Date | null;
  reviewNote: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type OrganizationChecklist = {
  infoCompleted: boolean;
  documentsUploaded: boolean;
  areasSelected: boolean;
  servicesSet: boolean;
  canSubmit: boolean;
};

export enum StaffInviteStatus {
  PENDING = 'pending',
  ACCEPTED = 'accepted',
  DECLINED = 'declined',
  REVOKED = 'revoked',
}

/** An invite stays open this long. */
export const STAFF_INVITE_DAYS = 7;
/**
 * Default until counsel answers (data inventory question 11): invites not accepted are deleted —
 * number and name — this many days after they expire; the organization keeps only a count.
 */
export const LAPSED_INVITE_RETENTION_DAYS = 30;

/**
 * Spec §7.11 `/org/staff/invite`: an owner invites a nurse or doctor by phone. A new number signs up
 * with it and becomes `provider_staff` of the organization; an independent provider can accept it in
 * the app (no active bookings, zero balance). Staff still need document verification.
 */
export interface IStaffInvite {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  phone: string;
  fullName: string;
  type: ProviderType;
  status: StaffInviteStatus;
  invitedBy: Types.ObjectId;
  expiresAt: Date;
  respondedAt: Date | null;
  /** Who accepted it. */
  userId: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Spec §4.7 `subscription_plans` (for organizations). Prices in piastres a month. */
export interface ISubscriptionPlan {
  _id: Types.ObjectId;
  /** Stable key, e.g. "starter" (the free plan new organizations start on). */
  key: string;
  nameAr: string;
  nameEn: string | null;
  monthlyPrice: number;
  maxStaff: number;
  /** Feature labels shown on the plan card (free text, both languages). */
  features: Array<{ ar: string; en: string | null }>;
  isActive: boolean;
  /** The plan organizations are on until they choose one. Exactly one. */
  isDefault: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

/** The organization's current plan period (paid plans are billed per month from its ledger). */
export type OrganizationSubscription = {
  planId: Types.ObjectId;
  /** null for a free plan. */
  periodStart: Date | null;
  periodEnd: Date | null;
};

/**
 * Monthly statement for an organization (spec §7.11 `/org/invoices`; decision M3.4: a statement of
 * platform charges, not a tax invoice — ETA e-invoices come later). Piastres.
 */
export interface IOrgStatement {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  /** Cairo month, "YYYY-MM". */
  period: string;
  /** e.g. "RY-ST-202610-4F2A9C". */
  number: string;
  /** Visits completed in the month and the platform's commission on them (cash and card). */
  visits: number;
  commission: number;
  /** Plan fees charged in the month, and credits for unused paid time. */
  subscriptionFees: number;
  subscriptionCredits: number;
  /** commission + subscriptionFees − subscriptionCredits. */
  total: number;
  /** Private storage key of the PDF. */
  pdfKey: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * One month of a paid plan (decision after M3.4). Kept apart from the earnings balance so plan fees never
 * count toward the cash-commission limit: it is settled by taking it from the organization's available
 * earnings (daily and at each payout batch — only then does it appear on the ledger) or by paying it in
 * the app. Still unpaid after `plan_fee_notice_days` → the owner is told; after `plan_fee_downgrade_days`
 * → the organization moves to the free default plan (the fee stays owed).
 */
export interface IPlanCharge {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  planId: Types.ObjectId;
  planKey: string;
  amount: number;
  /** Given back when changing plan before the month ended (taken off what's left to pay). */
  credited: number;
  creditedAt: Date | null;
  /** Still to pay. */
  remaining: number;
  periodStart: Date;
  periodEnd: Date;
  chargedAt: Date;
  settledAt: Date | null;
  overdueNoticeAt: Date | null;
  downgradedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
