import { Schema, model, type Model } from 'mongoose';
import type { ICatalogService } from '../../../interfaces/ICatalog';
import { PricingUnit, ProviderType } from '../../../interfaces/enums';
import { baseSchemaOptions, piastresValidator, uniqueAmongActive } from '../../schema-options';
import { softDeletePlugin, type SoftDeleteMethods } from '../../plugins/soft-delete.plugin';
import { BookingType } from '../../../interfaces/IBooking';

type CatalogServiceModelType = Model<ICatalogService, object, SoftDeleteMethods>;

const catalogServiceSchema = new Schema<ICatalogService, CatalogServiceModelType, SoftDeleteMethods>(
  {
    categoryId: { type: Schema.Types.ObjectId, ref: 'ServiceCategory', required: true },
    nameAr: { type: String, required: true, trim: true },
    nameEn: { type: String, trim: true, default: null },
    descriptionAr: { type: String, trim: true, default: null },
    descriptionEn: { type: String, trim: true, default: null },
    providerType: { type: String, enum: Object.values(ProviderType), required: true },
    pricingUnit: { type: String, enum: Object.values(PricingUnit), required: true },
    defaultDurationMinutes: { type: Number, required: true, min: 1 },
    minPrice: { type: Number, default: null, validate: piastresValidator },
    maxPrice: { type: Number, default: null, validate: piastresValidator },
    visitTypes: {
      type: [String],
      enum: [BookingType.HOME_VISIT, BookingType.CLINIC_VISIT],
      default: [BookingType.HOME_VISIT],
    },
    clinicMinPrice: { type: Number, default: null, validate: piastresValidator },
    clinicMaxPrice: { type: Number, default: null, validate: piastresValidator },
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
  },
  baseSchemaOptions,
);

catalogServiceSchema.plugin(softDeletePlugin);
catalogServiceSchema.index({ categoryId: 1, nameAr: 1 }, uniqueAmongActive);

/** Collection `services` (spec §4.5). Named CatalogService in code to avoid clashing with TypeDI's `Service`. */
export const CatalogServiceModel = model<ICatalogService, CatalogServiceModelType>(
  'CatalogService',
  catalogServiceSchema,
  'services',
);
