import { Service } from 'typedi';
import { PatientProfileModel } from '../../database/models/patient/patient-profile.model';
import {
  AllergyModel,
  MedicalConditionModel,
  MedicalDocumentModel,
  MedicationModel,
} from '../../database/models/patient/medical-records.model';
import { Relation, type Gender } from '../../interfaces/enums';
import type { IAllergy, IMedicalCondition, IMedication } from '../../interfaces/IMedical';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/types-errors';
import { applyPatch, type AuditContext } from '../audit/audit.service';
import { auditMedical } from './medical-audit';

export type PatientProfileInput = {
  fullName: string;
  relation: Exclude<Relation, Relation.SELF>;
  gender: Gender;
  dateOfBirth: Date;
  bloodType?: string | null;
};

/**
 * Patient profiles (spec §4.3, §7.6): the account holder ("self", created at sign-up) and family
 * members. Every lookup is scoped to the owner — another user's profile is simply "not found".
 */
@Service()
export class PatientProfileService {
  list(userId: string) {
    return PatientProfileModel.find({ ownerUserId: userId }).sort({ createdAt: 1 });
  }

  async getOwned(userId: string, profileId: string) {
    const profile = await PatientProfileModel.findOne({ _id: profileId, ownerUserId: userId });
    if (!profile) throw new NotFoundError('errors.patient_profile_not_found');
    return profile;
  }

  async create(userId: string, input: PatientProfileInput, context: AuditContext) {
    const profile = await PatientProfileModel.create({ ...input, ownerUserId: userId });
    if (input.bloodType) {
      await auditMedical(context, 'medical_record.create', String(profile._id), { section: 'blood_type' });
    }
    return profile;
  }

  /** The "self" profile's relation is fixed; family members can't become "self". */
  async update(
    userId: string,
    profileId: string,
    patch: Partial<PatientProfileInput>,
    context: AuditContext,
  ) {
    const profile = await this.getOwned(userId, profileId);
    if (profile.relation === Relation.SELF && patch.relation) {
      throw new ValidationError({ relation: ['validation.self_relation_fixed'] });
    }
    const changes = applyPatch(profile, patch);
    if (Object.keys(changes).length) {
      await profile.save();
      if ('bloodType' in changes) {
        await auditMedical(context, 'medical_record.update', profileId, { section: 'blood_type' });
      }
    }
    return profile;
  }

  async remove(userId: string, profileId: string) {
    const profile = await this.getOwned(userId, profileId);
    if (profile.relation === Relation.SELF) throw new ConflictError('errors.cannot_delete_self_profile');
    await profile.softDelete();
  }

  /** Full medical summary for GET /patient-profiles/{id}. Audited as a medical-data read. */
  async medicalSummary(profileId: string, context: AuditContext) {
    const [conditions, medications, allergies, documentsCount] = await Promise.all([
      MedicalConditionModel.find({ patientProfileId: profileId }).sort({ createdAt: 1 }),
      MedicationModel.find({ patientProfileId: profileId }).sort({ createdAt: 1 }),
      AllergyModel.find({ patientProfileId: profileId }).sort({ createdAt: 1 }),
      MedicalDocumentModel.countDocuments({ patientProfileId: profileId }),
    ]);
    await auditMedical(context, 'medical_profile.read', profileId, { section: 'summary' });
    // toObject() runs the decrypting getters.
    return {
      conditions: conditions.map((c) => c.toObject() as IMedicalCondition),
      medications: medications.map((m) => m.toObject() as IMedication),
      allergies: allergies.map((a) => a.toObject() as IAllergy),
      documentsCount,
    };
  }
}
