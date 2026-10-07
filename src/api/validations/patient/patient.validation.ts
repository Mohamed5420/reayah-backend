import { Gender, Relation } from '../../../interfaces/enums';
import { AllergySeverity, MedicalDocumentType } from '../../../interfaces/IMedical';
import { dateOfBirth, fullName } from '../auth/auth.validation';
import { objectId, z } from '../zod';

const familyRelation = z.enum([
  Relation.FATHER,
  Relation.MOTHER,
  Relation.CHILD,
  Relation.SPOUSE,
  Relation.SIBLING,
  Relation.OTHER,
]);
const bloodType = z.enum(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']);
const notes = z.string().trim().max(1000).nullable();
const recordName = z.string().trim().min(1).max(200);

const createProfileBody = z
  .object({
    full_name: fullName,
    relation: familyRelation,
    gender: z.enum(Gender),
    date_of_birth: dateOfBirth,
    blood_type: bloodType.nullable().optional(),
  })
  .openapi('CreatePatientProfile');

const conditionBody = z
  .object({ name: recordName.openapi({ example: 'سكر' }), notes: notes.optional() })
  .openapi('ConditionInput');
const medicationBody = z
  .object({
    name: recordName.openapi({ example: 'Glucophage' }),
    dosage: z.string().trim().max(100).nullable().optional().openapi({ example: '1000mg' }),
    frequency: z.string().trim().max(100).nullable().optional().openapi({ example: 'مرتين يومياً' }),
    notes: notes.optional(),
  })
  .openapi('MedicationInput');
const allergyBody = z
  .object({ name: recordName.openapi({ example: 'بنسلين' }), severity: z.enum(AllergySeverity) })
  .openapi('AllergyInput');

const condition = z
  .object({ id: objectId, name: z.string(), notes: z.string().nullable() })
  .openapi('Condition');
const medication = z
  .object({
    id: objectId,
    name: z.string(),
    dosage: z.string().nullable(),
    frequency: z.string().nullable(),
    notes: z.string().nullable(),
  })
  .openapi('Medication');
const allergy = z
  .object({ id: objectId, name: z.string(), severity: z.enum(AllergySeverity) })
  .openapi('Allergy');

const profile = z
  .object({
    id: objectId,
    full_name: z.string(),
    relation: z.enum(Relation),
    gender: z.enum(Gender),
    date_of_birth: z.string(),
    age: z.number(),
    blood_type: z.string().nullable(),
  })
  .openapi('PatientProfile');

/** Request and response schemas for /patient-profiles (spec §7.6). */
export const PatientSchemas = {
  idParams: z.object({ id: objectId }),
  recordParams: z.object({ id: objectId, record_id: objectId }),

  createProfileBody,
  updateProfileBody: createProfileBody.partial().openapi('UpdatePatientProfile'),
  profile,
  profileDetail: profile
    .extend({
      conditions: z.array(condition),
      medications: z.array(medication),
      allergies: z.array(allergy),
      documents_count: z.number(),
      visit_reports_count: z.number(),
    })
    .openapi('PatientProfileDetail'),

  conditionBody,
  conditionPatch: conditionBody.partial(),
  condition,
  medicationBody,
  medicationPatch: medicationBody.partial(),
  medication,
  allergyBody,
  allergyPatch: allergyBody.partial(),
  allergy,

  attachDocumentBody: z
    .object({
      file_key: z.string().min(1).max(300).openapi({ example: 'tmp/665f.../medical_document/9f2c....pdf' }),
      type: z.enum(MedicalDocumentType),
      title: z.string().trim().max(200).nullable().optional().openapi({ example: 'روشتة د. سامي' }),
    })
    .openapi('AttachMedicalDocument'),
  document: z
    .object({
      id: objectId,
      type: z.enum(MedicalDocumentType),
      title: z.string().nullable(),
      mime: z.string(),
      /** Signed, valid 10 minutes. */
      file_url: z.string(),
      uploaded_at: z.string(),
    })
    .openapi('MedicalDocument'),
};
