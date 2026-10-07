import type { Types } from 'mongoose';

/**
 * Spec §4.3 medical records, each attached to one patient profile. Free-text medical content is
 * encrypted at rest (spec §9), so these models must not be read with `.lean()`.
 */
interface MedicalRecordBase {
  _id: Types.ObjectId;
  patientProfileId: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface IMedicalCondition extends MedicalRecordBase {
  name: string;
  notes: string | null;
}

export interface IMedication extends MedicalRecordBase {
  name: string;
  dosage: string | null;
  frequency: string | null;
  notes: string | null;
}

export enum AllergySeverity {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
}

export interface IAllergy extends MedicalRecordBase {
  name: string;
  severity: AllergySeverity;
}

export enum MedicalDocumentType {
  PRESCRIPTION = 'prescription',
  LAB_RESULT = 'lab_result',
  REPORT = 'report',
  OTHER = 'other',
}

export interface IMedicalDocument extends MedicalRecordBase {
  type: MedicalDocumentType;
  title: string | null;
  /** Private storage key; clients get a short-lived signed URL. */
  fileKey: string;
  mime: string;
  uploadedBy: Types.ObjectId;
}
