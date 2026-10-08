import type { Types } from 'mongoose';
import type { UserRole } from './enums';

/** What a person agrees to (launch decision; wording from counsel, published by a super admin). */
export enum ConsentKind {
  TERMS = 'terms',
  PRIVACY = 'privacy',
  /** Explicit consent to process health data (Law 151/2020: sensitive data). */
  HEALTH_DATA = 'health_data',
}

export enum ConsentAction {
  ACCEPTED = 'accepted',
  WITHDRAWN = 'withdrawn',
}

/** One published version of a consent text. Never edited: a change is a new version. */
export interface IConsentDocument {
  _id: Types.ObjectId;
  kind: ConsentKind;
  /** 1, 2, 3… per kind. */
  version: number;
  titleAr: string;
  titleEn: string | null;
  /** The text shown to the person (plain text / Markdown). */
  bodyAr: string;
  bodyEn: string | null;
  /** Optional public page with the same text (privacy policy URL for the stores). */
  url: string | null;
  /** Roles that must accept it (e.g. health data: patients). */
  roles: UserRole[];
  publishedBy: Types.ObjectId | null;
  createdAt: Date;
}

/** Append-only evidence: who accepted or withdrew which version, when, from which IP. */
export interface IConsentRecord {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  kind: ConsentKind;
  version: number;
  documentId: Types.ObjectId;
  action: ConsentAction;
  ip: string | null;
  createdAt: Date;
}
