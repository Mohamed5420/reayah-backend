import { Schema, model, type Model, type SchemaDefinition } from 'mongoose';
import {
  AllergySeverity,
  MedicalDocumentType,
  type IAllergy,
  type IMedicalCondition,
  type IMedicalDocument,
  type IMedication,
} from '../../../interfaces/IMedical';
import { baseSchemaOptions } from '../../schema-options';
import { softDeletePlugin, type SoftDeleteMethods } from '../../plugins/soft-delete.plugin';
import { encryptedString } from '../../../utils/crypto/field-encryption';

/** Medical text is encrypted at rest (spec §9); getters decrypt on read and in toJSON/toObject. */
const required = () => encryptedString({ required: true });
const optional = () => encryptedString<string | null>({ default: null });

const medicalModel = <T>(name: string, collection: string, fields: SchemaDefinition<T>) => {
  const schema = new Schema<T, Model<T, object, SoftDeleteMethods>, SoftDeleteMethods>(
    {
      patientProfileId: { type: Schema.Types.ObjectId, ref: 'PatientProfile', required: true, index: true },
      ...fields,
    } as SchemaDefinition<T>,
    { ...baseSchemaOptions, toJSON: { getters: true }, toObject: { getters: true } },
  );
  schema.plugin(softDeletePlugin);
  return model<T, Model<T, object, SoftDeleteMethods>>(name, schema, collection);
};

export const MedicalConditionModel = medicalModel<IMedicalCondition>(
  'MedicalCondition',
  'medical_conditions',
  {
    name: required(),
    notes: optional(),
  },
);

export const MedicationModel = medicalModel<IMedication>('Medication', 'medications', {
  name: required(),
  dosage: optional(),
  frequency: optional(),
  notes: optional(),
});

export const AllergyModel = medicalModel<IAllergy>('Allergy', 'allergies', {
  name: required(),
  severity: { type: String, enum: Object.values(AllergySeverity), required: true },
});

export const MedicalDocumentModel = medicalModel<IMedicalDocument>('MedicalDocument', 'medical_documents', {
  type: { type: String, enum: Object.values(MedicalDocumentType), required: true },
  title: optional(),
  fileKey: { type: String, required: true },
  mime: { type: String, required: true },
  uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
});
