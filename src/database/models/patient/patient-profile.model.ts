import { Schema, model, type Model } from 'mongoose';
import type { IPatientProfile } from '../../../interfaces/IProfiles';
import { Gender, Relation } from '../../../interfaces/enums';
import { baseSchemaOptions } from '../../schema-options';
import { softDeletePlugin, type SoftDeleteMethods } from '../../plugins/soft-delete.plugin';
import { encryptedString } from '../../../utils/crypto/field-encryption';

type PatientProfileModelType = Model<IPatientProfile, object, SoftDeleteMethods>;

const patientProfileSchema = new Schema<IPatientProfile, PatientProfileModelType, SoftDeleteMethods>(
  {
    ownerUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    fullName: { type: String, required: true, trim: true },
    relation: { type: String, enum: Object.values(Relation), required: true },
    gender: { type: String, enum: Object.values(Gender), required: true },
    dateOfBirth: { type: Date, required: true },
    bloodType: encryptedString<string | null>({ default: null }),
  },
  { ...baseSchemaOptions, toJSON: { getters: true }, toObject: { getters: true } },
);

patientProfileSchema.plugin(softDeletePlugin);
patientProfileSchema.index({ ownerUserId: 1 });
// Exactly one "self" profile per account.
patientProfileSchema.index(
  { ownerUserId: 1 },
  {
    name: 'one_self_profile_per_owner',
    unique: true,
    partialFilterExpression: { relation: Relation.SELF, deletedAt: { $type: 'null' } },
  },
);

export const PatientProfileModel = model<IPatientProfile, PatientProfileModelType>(
  'PatientProfile',
  patientProfileSchema,
);
