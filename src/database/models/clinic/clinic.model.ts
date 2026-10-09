import { Schema, model, type Model } from 'mongoose';
import { ClinicStatus, type IClinic } from '../../../interfaces/IClinic';
import { baseSchemaOptions } from '../../schema-options';
import { softDeletePlugin, type SoftDeleteMethods } from '../../plugins/soft-delete.plugin';

type ClinicModelType = Model<IClinic, object, SoftDeleteMethods>;

const clinicSchema = new Schema<IClinic, ClinicModelType, SoftDeleteMethods>(
  {
    providerProfileId: { type: Schema.Types.ObjectId, ref: 'ProviderProfile', default: null },
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', default: null },
    name: { type: String, required: true, trim: true },
    governorateId: { type: Schema.Types.ObjectId, ref: 'Governorate', required: true },
    areaId: { type: Schema.Types.ObjectId, ref: 'Area', required: true },
    street: { type: String, required: true, trim: true },
    building: { type: String, trim: true, default: null },
    floor: { type: String, trim: true, default: null },
    landmark: { type: String, trim: true, default: null },
    phone: { type: String, required: true },
    isActive: { type: Boolean, default: true },
    status: { type: String, enum: Object.values(ClinicStatus), default: ClinicStatus.DRAFT },
    adminMessage: { type: String, default: null },
    licence: {
      type: new Schema(
        {
          fileKey: { type: String, required: true },
          uploadedAt: { type: Date, required: true },
          expiresAt: { type: Date, default: null },
        },
        { _id: false },
      ),
      default: null,
    },
    licenceNoticeAt: { type: Date, default: null },
    submittedAt: { type: Date, default: null },
    reviewedAt: { type: Date, default: null },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  baseSchemaOptions,
);
clinicSchema.plugin(softDeletePlugin);
clinicSchema.index({ providerProfileId: 1 });
clinicSchema.index({ organizationId: 1 });
// The admin queue, and clinic search by area (C2).
clinicSchema.index({ status: 1, submittedAt: 1 });
clinicSchema.index({ areaId: 1, status: 1, isActive: 1 });

export const ClinicModel = model<IClinic, ClinicModelType>('Clinic', clinicSchema);
