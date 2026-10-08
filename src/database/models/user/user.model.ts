import { Schema, model, type Model } from 'mongoose';
import { type IUser } from '../../../interfaces/IUser';
import { AdminRole, Gender, UserRole, UserStatus } from '../../../interfaces/enums';
import { SUPPORTED_LANGUAGES } from '../../../utils/i18n';
import { baseSchemaOptions, uniqueAmongActive } from '../../schema-options';
import { softDeletePlugin, type SoftDeleteMethods } from '../../plugins/soft-delete.plugin';

type UserModelType = Model<IUser, object, SoftDeleteMethods>;

function notAdmin(this: IUser) {
  return this.role !== UserRole.ADMIN;
}

const userSchema = new Schema<IUser, UserModelType, SoftDeleteMethods>(
  {
    phone: { type: String, required: true, trim: true },
    fullName: { type: String, required: true, trim: true },
    email: { type: String, trim: true, lowercase: true, default: null },
    gender: { type: String, enum: Object.values(Gender), default: null, required: notAdmin },
    dateOfBirth: { type: Date, default: null, required: notAdmin },
    role: { type: String, enum: Object.values(UserRole), required: true },
    language: { type: String, enum: SUPPORTED_LANGUAGES, default: 'ar' },
    avatarKey: { type: String, default: null },
    status: { type: String, enum: Object.values(UserStatus), default: UserStatus.ACTIVE },
    lastLoginAt: { type: Date, default: null },
    referredByCode: { type: String, default: null },
    referralCode: { type: String, default: null },
    adminRole: { type: String, enum: [...Object.values(AdminRole), null], default: null },
    isTestAccount: { type: Boolean, default: false },
    reception: {
      type: new Schema(
        {
          organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
          clinicId: { type: Schema.Types.ObjectId, ref: 'Clinic', required: true },
        },
        { _id: false },
      ),
      default: null,
    },
    deletionRequestedAt: { type: Date, default: null },
    isOnline: { type: Boolean, default: false },
    notificationSettings: {
      reminders: { type: Boolean, default: true },
      promotions: { type: Boolean, default: true },
      chat: { type: Boolean, default: true },
    },
  },
  baseSchemaOptions,
);

userSchema.plugin(softDeletePlugin);
// A deleted account frees its phone number for a new sign-up.
userSchema.index({ phone: 1 }, uniqueAmongActive);
userSchema.index({ role: 1, status: 1 });
userSchema.index(
  { referralCode: 1 },
  { unique: true, partialFilterExpression: { referralCode: { $type: 'string' } } },
);

export const UserModel = model<IUser, UserModelType>('User', userSchema);
