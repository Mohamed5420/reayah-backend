import { Schema, model } from 'mongoose';
import { OtpPurpose, type IOtpCode } from '../../../interfaces/IAuth';

const otpCodeSchema = new Schema<IOtpCode>(
  {
    phone: { type: String, required: true },
    purpose: { type: String, enum: Object.values(OtpPurpose), required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    consumedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

otpCodeSchema.index({ phone: 1, purpose: 1, createdAt: -1 });
// Short-lived by nature: MongoDB removes codes a day after they expire.
otpCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 24 * 3600 });

export const OtpCodeModel = model<IOtpCode>('OtpCode', otpCodeSchema);
