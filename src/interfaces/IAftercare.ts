import type { Types } from 'mongoose';

/** Spec §4.6 `visit_reports`: written by the provider after the visit; part of the patient's medical record. */
export interface IVisitReport {
  _id: Types.ObjectId;
  bookingId: Types.ObjectId;
  providerProfileId: Types.ObjectId;
  patientProfileId: Types.ObjectId;
  /** Medical — encrypted at rest. */
  summary: string;
  /** Encrypted JSON: { bp, pulse, temp, sugar, spo2 }. Read through VisitReportService. */
  vitalsData: string | null;
  /** Encrypted JSON array of strings. */
  proceduresData: string | null;
  recommendations: string | null;
  attachmentKeys: string[];
  createdAt: Date;
  updatedAt: Date;
}

export type Vitals = { bp?: string; pulse?: number; temp?: number; sugar?: number; spo2?: number };

/** Spec §4.6 `reviews`: one per completed booking. */
export interface IReview {
  _id: Types.ObjectId;
  bookingId: Types.ObjectId;
  patientUserId: Types.ObjectId;
  providerProfileId: Types.ObjectId;
  rating: number;
  comment: string | null;
  tags: string[];
  isVisible: boolean;
  /** Auto-set when the comment looks like it contains a phone number, email or link. */
  flagged: boolean;
  /** Admin masked contact details in the comment; the original is kept for audit. */
  originalComment: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export enum DisputeStatus {
  OPEN = 'open',
  RESOLVED = 'resolved',
}

export enum DisputeResolution {
  REFUND = 'refund',
  PARTIAL_REFUND = 'partial_refund',
  NO_ACTION = 'no_action',
}

/** Who pays for a dispute refund (product decision): the provider's share, the platform, or split by amount. */
export enum RefundBearer {
  PROVIDER = 'provider',
  PLATFORM = 'platform',
  SPLIT = 'split',
}

export enum ProviderAction {
  NONE = 'none',
  WARN = 'warn',
  SUSPEND = 'suspend',
}

/** Spec §7.8 / §7.15 disputes ("report a problem"). */
export interface IDispute {
  _id: Types.ObjectId;
  bookingId: Types.ObjectId;
  patientUserId: Types.ObjectId;
  providerProfileId: Types.ObjectId | null;
  reasonCode: string;
  description: string | null;
  attachmentKeys: string[];
  status: DisputeStatus;
  resolution: {
    type: DisputeResolution;
    /** Piastres. Cash bookings: recorded only — refunds through the app arrive with card payments (Phase 2). */
    refundAmount: number;
    refundBearer: RefundBearer;
    /** Part of the refund taken from the provider (a ledger debit); the rest is the platform's cost. */
    providerShare: number;
    providerAction: ProviderAction;
    suspendDays: number | null;
    messageToPatient: string | null;
    messageToProvider: string | null;
    resolvedBy: Types.ObjectId;
    resolvedAt: Date;
  } | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Spec §4.10 `user_suspensions`. `endsAt: null` = until lifted. */
export interface IUserSuspension {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  reason: string;
  startsAt: Date;
  endsAt: Date | null;
  createdBy: Types.ObjectId | null;
  liftedAt: Date | null;
  createdAt: Date;
}

/** Spec §4.10 `user_warnings`. */
export interface IUserWarning {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  reason: string;
  relatedType: 'booking' | 'dispute' | 'review' | null;
  relatedId: string | null;
  createdBy: Types.ObjectId | null;
  createdAt: Date;
}
