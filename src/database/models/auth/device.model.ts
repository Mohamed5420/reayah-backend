import { Schema, model } from 'mongoose';
import type { IDevice } from '../../../interfaces/IAuth';
import { DevicePlatform } from '../../../interfaces/enums';
import { baseSchemaOptions } from '../../schema-options';

const deviceSchema = new Schema<IDevice>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // An FCM token identifies one app install; it moves to whoever logs in on that device.
    fcmToken: { type: String, required: true, unique: true },
    platform: { type: String, enum: Object.values(DevicePlatform), required: true },
    appVersion: { type: String, default: null },
    lastSeenAt: { type: Date, default: () => new Date() },
  },
  baseSchemaOptions,
);

export const DeviceModel = model<IDevice>('Device', deviceSchema);
