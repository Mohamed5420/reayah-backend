import { Schema, model } from 'mongoose';
import {
  DisputeResolution,
  DisputeStatus,
  ProviderAction,
  type IDispute,
  type IReview,
  type IUserSuspension,
  type IUserWarning,
  type IVisitReport,
} from '../../../interfaces/IAftercare';
import { baseSchemaOptions } from '../../schema-options';
import { encryptOnWrite, encryptedString } from '../../../utils/crypto/field-encryption';

const visitReportSchema = new Schema<IVisitReport>(
  {
    bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true, unique: true },
    providerProfileId: { type: Schema.Types.ObjectId, ref: 'ProviderProfile', required: true },
    patientProfileId: { type: Schema.Types.ObjectId, ref: 'PatientProfile', required: true, index: true },
    summary: encryptedString({ required: true }),
    vitalsData: encryptedString<string | null>({ default: null }),
    proceduresData: encryptedString<string | null>({ default: null }),
    recommendations: encryptedString<string | null>({ default: null }),
    attachmentKeys: { type: [String], default: [] },
  },
  { ...baseSchemaOptions, toJSON: { getters: true }, toObject: { getters: true } },
);
export const VisitReportModel = model<IVisitReport>('VisitReport', visitReportSchema, 'visit_reports');

const reviewSchema = new Schema<IReview>(
  {
    bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true, unique: true },
    patientUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    providerProfileId: { type: Schema.Types.ObjectId, ref: 'ProviderProfile', required: true },
    rating: { type: Number, required: true, min: 1, max: 5 },
    comment: { type: String, trim: true, default: null },
    tags: { type: [String], default: [] },
    isVisible: { type: Boolean, default: true },
    flagged: { type: Boolean, default: false },
    originalComment: { type: String, default: null },
  },
  baseSchemaOptions,
);
reviewSchema.index({ providerProfileId: 1, isVisible: 1, createdAt: -1 });
reviewSchema.index({ flagged: 1, createdAt: -1 });
export const ReviewModel = model<IReview>('Review', reviewSchema);

const disputeSchema = new Schema<IDispute>(
  {
    bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true, unique: true },
    patientUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    providerProfileId: { type: Schema.Types.ObjectId, ref: 'ProviderProfile', default: null },
    reasonCode: { type: String, required: true },
    // May describe health details: encrypted at rest; decrypted + audited where shown.
    description: encryptOnWrite({ default: null }),
    attachmentKeys: { type: [String], default: [] },
    status: { type: String, enum: Object.values(DisputeStatus), default: DisputeStatus.OPEN },
    resolution: {
      type: new Schema(
        {
          type: { type: String, enum: Object.values(DisputeResolution), required: true },
          refundAmount: { type: Number, default: 0 },
          providerAction: { type: String, enum: Object.values(ProviderAction), default: ProviderAction.NONE },
          suspendDays: { type: Number, default: null },
          messageToPatient: { type: String, default: null },
          messageToProvider: { type: String, default: null },
          resolvedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
          resolvedAt: { type: Date, required: true },
        },
        { _id: false },
      ),
      default: null,
    },
  },
  baseSchemaOptions,
);
disputeSchema.index({ status: 1, createdAt: 1 });
disputeSchema.index({ providerProfileId: 1 });
export const DisputeModel = model<IDispute>('Dispute', disputeSchema);

const userSuspensionSchema = new Schema<IUserSuspension>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    reason: { type: String, required: true },
    startsAt: { type: Date, required: true },
    endsAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    liftedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);
// Sweep for timed suspensions that have run out.
userSuspensionSchema.index({ liftedAt: 1, endsAt: 1 });
export const UserSuspensionModel = model<IUserSuspension>(
  'UserSuspension',
  userSuspensionSchema,
  'user_suspensions',
);

const userWarningSchema = new Schema<IUserWarning>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    reason: { type: String, required: true },
    relatedType: { type: String, enum: ['booking', 'dispute', 'review', null], default: null },
    relatedId: { type: String, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);
export const UserWarningModel = model<IUserWarning>('UserWarning', userWarningSchema, 'user_warnings');
