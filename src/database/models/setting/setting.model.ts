import { Schema, model } from 'mongoose';
import type { ISetting } from '../../../interfaces/ISetting';
import { baseSchemaOptions } from '../../schema-options';

const settingSchema = new Schema<ISetting>(
  {
    key: { type: String, required: true, unique: true },
    value: { type: Schema.Types.Mixed, required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  baseSchemaOptions,
);

export const SettingModel = model<ISetting>('Setting', settingSchema);
