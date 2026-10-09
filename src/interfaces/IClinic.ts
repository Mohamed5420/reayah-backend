import type { Types } from 'mongoose';
import type { IAvailabilitySlot } from './IProfiles';

/** A clinic's review state (clinic visits, C1): a clinic is bookable only once approved. */
export enum ClinicStatus {
  DRAFT = 'draft',
  PENDING = 'pending',
  APPROVED = 'approved',
  CHANGES_REQUESTED = 'changes_requested',
  REJECTED = 'rejected',
}

/** The owner can edit and (re)submit in these states; an approved clinic whose address changes goes back to pending. */
export const CLINIC_EDITABLE_STATUSES = [
  ClinicStatus.DRAFT,
  ClinicStatus.CHANGES_REQUESTED,
  ClinicStatus.REJECTED,
];

/**
 * A place where patients come for clinic visits: an independent doctor's clinic, or an organization's
 * branch (C4). Text address only — no coordinates, no maps (same rule as everywhere).
 */
export interface IClinic {
  _id: Types.ObjectId;
  /** Exactly one owner: an independent doctor's profile or an organization. */
  providerProfileId: Types.ObjectId | null;
  organizationId: Types.ObjectId | null;
  name: string;
  governorateId: Types.ObjectId;
  /** Must be a bookable area of the governorate; clinic search matches on it (C2). */
  areaId: Types.ObjectId;
  street: string;
  building: string | null;
  floor: string | null;
  landmark: string | null;
  /** Shown to patients after booking only (decision). */
  phone: string;
  /** The owner can pause a clinic without deleting it. */
  isActive: boolean;
  status: ClinicStatus;
  adminMessage: string | null;
  /** The clinic's licence (private storage key, never a URL). */
  licence: { fileKey: string; uploadedAt: Date; expiresAt: Date | null } | null;
  /** When the owner was warned that the licence is about to expire (once per licence). */
  licenceNoticeAt?: Date | null;
  submittedAt: Date | null;
  reviewedAt: Date | null;
  reviewedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/** On a doctor's profile: one entry per clinic they work at — their own, or a branch (C4). */
export interface IProviderClinic {
  clinicId: Types.ObjectId;
  /** Appointment length; null = the service's duration. */
  slotMinutes: number | null;
  /** Bookings for a free slot are confirmed at once (default, decision); off = the doctor accepts each. */
  instantConfirm: boolean;
  /** Weekly clinic hours (Cairo "HH:mm"); never overlapping home-visit hours or another clinic's. */
  hours: IAvailabilitySlot[];
}
