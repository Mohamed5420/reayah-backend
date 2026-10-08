import type { Types } from 'mongoose';
import type { Gender, ProviderType, Relation, VerificationStatus } from './enums';

/**
 * Spec §4.3 `patient_profiles`: the account holder ("self") and family members they book for.
 * Created at sign-up (self); managed in M1.3.
 */
export interface IPatientProfile {
  _id: Types.ObjectId;
  ownerUserId: Types.ObjectId;
  fullName: string;
  relation: Relation;
  gender: Gender;
  dateOfBirth: Date;
  /** Medical data — encrypted at rest. */
  bloodType: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/** Spec §4.4 `provider_service_areas` (embedded): coverage by area — never a radius (§1). */
export interface IProviderServiceArea {
  areaId: Types.ObjectId;
  /** Piastres added to home visits in this area; capped by the area's `maxTravelFee`. */
  travelFee: number;
}

/** Spec §4.5 `provider_services` (embedded): the provider's own price per catalog service. */
export interface IProviderService {
  serviceId: Types.ObjectId;
  /** Piastres per pricing unit; within the service's admin min/max when set. */
  price: number;
  isActive: boolean;
}

/** Spec §4.4 `provider_availability` (embedded): weekly recurring hours, Africa/Cairo local time. */
export interface IAvailabilitySlot {
  /** 0 = Sunday … 6 = Saturday. */
  dayOfWeek: number;
  /** "HH:mm", 24-hour; `endTime` > `startTime` (no overnight slots — split them across days). */
  startTime: string;
  endTime: string;
}

/** Spec §4.4 `provider_profiles`. Created as a draft at sign-up; onboarding + verification in M1.4. */
export interface IProviderProfile {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  /** null = independent provider. */
  organizationId: Types.ObjectId | null;
  /** Staff only: suspended by their organization's owner (not an admin account suspension). */
  staffSuspended: boolean;
  /** Chosen during onboarding. */
  type: ProviderType | null;
  specialty: string | null;
  yearsOfExperience: number | null;
  bio: string | null;
  languages: string[];
  /** Encrypted at rest (spec §9). */
  licenseNumber: string | null;
  syndicateNumber: string | null;
  verificationStatus: VerificationStatus;
  rejectionReason: string | null;
  adminMessage: string | null;
  submittedAt: Date | null;
  reviewedAt: Date | null;
  reviewedBy: Types.ObjectId | null;
  serviceAreas: IProviderServiceArea[];
  services: IProviderService[];
  availability: IAvailabilitySlot[];
  ratingAvg: number;
  ratingCount: number;
  completedVisitsCount: number;
  isAcceptingBookings: boolean;
  /** Copied from the account at sign-up (test numbers); test providers only meet test patients in production. */
  isTestAccount: boolean;
  /** Internal: serializes booking transactions per provider. */
  scheduleVersion: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}
