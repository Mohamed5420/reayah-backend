import { Schema, model, type Model } from 'mongoose';
import type { IAddress } from '../../../interfaces/IAddress';
import { baseSchemaOptions } from '../../schema-options';
import { softDeletePlugin, type SoftDeleteMethods } from '../../plugins/soft-delete.plugin';

type AddressModelType = Model<IAddress, object, SoftDeleteMethods>;

const text = { type: String, trim: true, default: null };

const addressSchema = new Schema<IAddress, AddressModelType, SoftDeleteMethods>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    label: { type: String, required: true, trim: true },
    governorateId: { type: Schema.Types.ObjectId, ref: 'Governorate', required: true },
    areaId: { type: Schema.Types.ObjectId, ref: 'Area', required: true },
    street: { type: String, required: true, trim: true },
    building: text,
    floor: text,
    apartment: text,
    landmark: text,
    notes: text,
    isDefault: { type: Boolean, default: false },
  },
  // `strict: 'throw'`: a stray field (e.g. coordinates) is an error, never silently stored.
  { ...baseSchemaOptions, strict: 'throw' },
);

addressSchema.plugin(softDeletePlugin);
addressSchema.index({ userId: 1, createdAt: -1 });
// At most one default address per user.
addressSchema.index(
  { userId: 1 },
  {
    name: 'one_default_address_per_user',
    unique: true,
    partialFilterExpression: { isDefault: true, deletedAt: { $type: 'null' } },
  },
);

export const AddressModel = model<IAddress, AddressModelType>('Address', addressSchema);
