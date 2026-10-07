import { Schema, model, type Model } from 'mongoose';
import type { IGovernorate } from '../../../interfaces/ILocation';
import { baseSchemaOptions, uniqueAmongActive } from '../../schema-options';
import { softDeletePlugin, type SoftDeleteMethods } from '../../plugins/soft-delete.plugin';

type GovernorateModelType = Model<IGovernorate, object, SoftDeleteMethods>;

const governorateSchema = new Schema<IGovernorate, GovernorateModelType, SoftDeleteMethods>(
  {
    nameAr: { type: String, required: true, trim: true },
    nameEn: { type: String, trim: true, default: null },
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
  },
  baseSchemaOptions,
);

governorateSchema.plugin(softDeletePlugin);
governorateSchema.index({ nameAr: 1 }, uniqueAmongActive);

export const GovernorateModel = model<IGovernorate, GovernorateModelType>('Governorate', governorateSchema);
