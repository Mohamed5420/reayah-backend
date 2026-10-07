import { Schema, model, type Model } from 'mongoose';
import type { IProviderTimeOff } from '../../../interfaces/IProvider';
import { baseSchemaOptions } from '../../schema-options';
import { softDeletePlugin, type SoftDeleteMethods } from '../../plugins/soft-delete.plugin';

type ProviderTimeOffModelType = Model<IProviderTimeOff, object, SoftDeleteMethods>;

const providerTimeOffSchema = new Schema<IProviderTimeOff, ProviderTimeOffModelType, SoftDeleteMethods>(
  {
    providerProfileId: { type: Schema.Types.ObjectId, ref: 'ProviderProfile', required: true },
    startsAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },
    reason: { type: String, trim: true, default: null },
  },
  baseSchemaOptions,
);

providerTimeOffSchema.plugin(softDeletePlugin);
// Slot calculation (M1.5): time off overlapping a date range.
providerTimeOffSchema.index({ providerProfileId: 1, endsAt: 1, startsAt: 1 });

export const ProviderTimeOffModel = model<IProviderTimeOff, ProviderTimeOffModelType>(
  'ProviderTimeOff',
  providerTimeOffSchema,
  'provider_time_off',
);
