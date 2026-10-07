import type { HydratedDocument, Model, Types } from 'mongoose';
import { Service } from 'typedi';
import {
  AllergyModel,
  MedicalConditionModel,
  MedicationModel,
} from '../../database/models/patient/medical-records.model';
import type { SoftDeleteMethods } from '../../database/plugins/soft-delete.plugin';
import type { IAllergy, IMedicalCondition, IMedication } from '../../interfaces/IMedical';
import { NotFoundError } from '../../utils/types-errors';
import { applyPatch, type AuditContext } from '../audit/audit.service';
import { auditMedical } from './medical-audit';

type RecordBase = { _id: Types.ObjectId; patientProfileId: Types.ObjectId };
type RecordModel = Model<RecordBase, object, SoftDeleteMethods>;
type RecordDoc = HydratedDocument<RecordBase, SoftDeleteMethods>;

/**
 * List / add / update / delete for one kind of medical record on one profile. The caller has already
 * checked that the profile belongs to the user. Returns plain, decrypted objects (`toObject()` runs
 * the decrypting getters). Audit entries record what changed, never the values.
 */
class MedicalRecords<T extends RecordBase> {
  private readonly model: RecordModel;

  constructor(
    model: unknown,
    readonly section: 'conditions' | 'medications' | 'allergies',
  ) {
    this.model = model as RecordModel;
  }

  async list(profileId: string, context: AuditContext): Promise<T[]> {
    const records = await this.model.find({ patientProfileId: profileId }).sort({ createdAt: 1 });
    await auditMedical(context, 'medical_profile.read', profileId, { section: this.section });
    return records.map(toPlain<T>);
  }

  async create(profileId: string, input: Partial<T>, context: AuditContext): Promise<T> {
    const record = await this.model.create({ ...input, patientProfileId: profileId });
    await auditMedical(context, 'medical_record.create', profileId, {
      section: this.section,
      recordId: String(record._id),
    });
    return toPlain<T>(record);
  }

  async update(profileId: string, recordId: string, patch: Partial<T>, context: AuditContext): Promise<T> {
    const record = await this.getOne(profileId, recordId);
    const changed = Object.keys(applyPatch(record, patch as Record<string, unknown>));
    if (changed.length) {
      await record.save();
      await auditMedical(context, 'medical_record.update', profileId, {
        section: this.section,
        recordId,
        fields: changed,
      });
    }
    return toPlain<T>(record);
  }

  async remove(profileId: string, recordId: string, context: AuditContext) {
    const record = await this.getOne(profileId, recordId);
    await record.softDelete();
    await auditMedical(context, 'medical_record.delete', profileId, { section: this.section, recordId });
  }

  private async getOne(profileId: string, recordId: string): Promise<RecordDoc> {
    const record = await this.model.findOne({ _id: recordId, patientProfileId: profileId });
    if (!record) throw new NotFoundError('errors.record_not_found');
    return record;
  }
}

const toPlain = <T>(doc: RecordDoc) => doc.toObject() as unknown as T;

/** The three list-style medical records (spec §7.6): conditions, medications, allergies. */
@Service()
export class MedicalRecordService {
  readonly conditions = new MedicalRecords<IMedicalCondition>(MedicalConditionModel, 'conditions');
  readonly medications = new MedicalRecords<IMedication>(MedicationModel, 'medications');
  readonly allergies = new MedicalRecords<IAllergy>(AllergyModel, 'allergies');
}
