import type { Types } from 'mongoose';
import type { VerificationStatus } from './enums';
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
  /** Spec §4.4; plans arrive in M3.4. */
  subscriptionPlanId: Types.ObjectId | null;
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
