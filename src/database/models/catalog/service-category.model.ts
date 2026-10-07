import { Schema, model, type Model } from 'mongoose';
import type { IServiceCategory } from '../../../interfaces/ICatalog';
import { baseSchemaOptions, uniqueAmongActive } from '../../schema-options';
import { softDeletePlugin, type SoftDeleteMethods } from '../../plugins/soft-delete.plugin';

type ServiceCategoryModelType = Model<IServiceCategory, object, SoftDeleteMethods>;

const serviceCategorySchema = new Schema<IServiceCategory, ServiceCategoryModelType, SoftDeleteMethods>(
  {
    key: { type: String, required: true, trim: true, lowercase: true },
    nameAr: { type: String, required: true, trim: true },
    nameEn: { type: String, trim: true, default: null },
    iconUrl: { type: String, default: null },
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
  },
  baseSchemaOptions,
);

serviceCategorySchema.plugin(softDeletePlugin);
serviceCategorySchema.index({ key: 1 }, uniqueAmongActive);

export const ServiceCategoryModel = model<IServiceCategory, ServiceCategoryModelType>(
  'ServiceCategory',
  serviceCategorySchema,
);
