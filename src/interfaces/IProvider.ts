import type { Types } from 'mongoose';

export enum ProviderDocumentType {
  LICENSE = 'license',
  SYNDICATE_CARD = 'syndicate_card',
  NATIONAL_ID_FRONT = 'national_id_front',
  NATIONAL_ID_BACK = 'national_id_back',
  CERTIFICATE = 'certificate',
  /** Criminal record certificate («الفيش الجنائي»): optional until `criminal_record_required` is on. */
  CRIMINAL_RECORD = 'criminal_record',
}

/** Types with one current document (a new upload replaces it); certificates can be many. */
export const SINGLE_PROVIDER_DOCUMENTS: ProviderDocumentType[] = [
  ProviderDocumentType.LICENSE,
  ProviderDocumentType.SYNDICATE_CARD,
  ProviderDocumentType.NATIONAL_ID_FRONT,
  ProviderDocumentType.NATIONAL_ID_BACK,
  ProviderDocumentType.CRIMINAL_RECORD,
];

/** The ID card's two sides are their own types, so they take no back page. */
export const NO_BACK_PAGE: ProviderDocumentType[] = [
  ProviderDocumentType.NATIONAL_ID_FRONT,
  ProviderDocumentType.NATIONAL_ID_BACK,
];

/** Needed before a provider can submit for verification (spec §1 "Trust"). Certificates are optional. */
export const REQUIRED_PROVIDER_DOCUMENTS = [
  ProviderDocumentType.LICENSE,
  ProviderDocumentType.SYNDICATE_CARD,
  ProviderDocumentType.NATIONAL_ID_FRONT,
  ProviderDocumentType.NATIONAL_ID_BACK,
];

/** Spec §4.4 per-document review result. */
export enum DocumentReviewStatus {
  PENDING = 'pending',
  MATCHING = 'matching',
  NOT_MATCHING = 'not_matching',
}

/** Spec §4.4 `provider_documents`. */
export interface IProviderDocument {
  _id: Types.ObjectId;
  providerProfileId: Types.ObjectId;
  type: ProviderDocumentType;
  fileKey: string;
  mime: string;
  /** Optional second page (the back of a card). */
  backFileKey: string | null;
  backMime: string | null;
  status: DocumentReviewStatus;
  /** License / syndicate card expiry (set by the provider or the reviewing admin). */
  expiresAt: Date | null;
  reviewedBy: Types.ObjectId | null;
  reviewedAt: Date | null;
  reviewNote: string | null;
  expiryNoticeAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/** Spec §4.4 `provider_time_off`. */
export interface IProviderTimeOff {
  _id: Types.ObjectId;
  providerProfileId: Types.ObjectId;
  startsAt: Date;
  endsAt: Date;
  reason: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}
