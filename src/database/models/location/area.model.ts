import { Schema, model, type Model } from 'mongoose';
import type { IArea } from '../../../interfaces/ILocation';
import { baseSchemaOptions, piastresValidator, uniqueAmongActive } from '../../schema-options';
import { softDeletePlugin, type SoftDeleteMethods } from '../../plugins/soft-delete.plugin';
import { normalizeSearchText } from '../../../utils/text/arabic';

type AreaModelType = Model<IArea, object, SoftDeleteMethods>;

export const buildAreaSearchName = (nameAr: string, nameEn: string | null) =>
  normalizeSearchText(`${nameAr} ${nameEn ?? ''}`);

const areaSchema = new Schema<IArea, AreaModelType, SoftDeleteMethods>(
  {
    governorateId: { type: Schema.Types.ObjectId, ref: 'Governorate', required: true },
    nameAr: { type: String, required: true, trim: true },
    nameEn: { type: String, trim: true, default: null },
    isActive: { type: Boolean, default: true },
    maxTravelFee: { type: Number, default: null, validate: piastresValidator },
    searchName: { type: String, default: '' },
  },
  baseSchemaOptions,
);

// Keep searchName in sync on create/save (bulk seeds set it themselves).
areaSchema.pre('validate', function () {
  this.searchName = buildAreaSearchName(this.nameAr, this.nameEn);
});

areaSchema.plugin(softDeletePlugin);
areaSchema.index({ governorateId: 1, nameAr: 1 }, uniqueAmongActive);
areaSchema.index({ isActive: 1, governorateId: 1 });

export const AreaModel = model<IArea, AreaModelType>('Area', areaSchema);
