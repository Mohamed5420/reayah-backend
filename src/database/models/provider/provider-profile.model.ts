import { Schema, model, type Model } from 'mongoose';
import type { IProviderProfile } from '../../../interfaces/IProfiles';
import { ProviderType, VerificationStatus } from '../../../interfaces/enums';
import { baseSchemaOptions, piastresValidator, uniqueAmongActive } from '../../schema-options';
import { softDeletePlugin, type SoftDeleteMethods } from '../../plugins/soft-delete.plugin';
import { encryptedString } from '../../../utils/crypto/field-encryption';

type ProviderProfileModelType = Model<IProviderProfile, object, SoftDeleteMethods>;

const providerProfileSchema = new Schema<IProviderProfile, ProviderProfileModelType, SoftDeleteMethods>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', default: null },
    staffSuspended: { type: Boolean, default: false },
    type: { type: String, enum: Object.values(ProviderType), default: null },
    specialty: { type: String, trim: true, default: null },
    yearsOfExperience: { type: Number, min: 0, default: null },
    bio: { type: String, trim: true, default: null },
    languages: { type: [String], default: [] },
    licenseNumber: encryptedString<string | null>({ default: null }),
    syndicateNumber: encryptedString<string | null>({ default: null }),
    verificationStatus: {
      type: String,
      enum: Object.values(VerificationStatus),
      default: VerificationStatus.DRAFT,
    },
    rejectionReason: { type: String, default: null },
    adminMessage: { type: String, default: null },
    submittedAt: { type: Date, default: null },
    reviewedAt: { type: Date, default: null },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    // Small lists that are always read with the profile — embedded (see BUILD_PLAN "Stack decision").
    serviceAreas: {
      type: [
        new Schema(
          {
            areaId: { type: Schema.Types.ObjectId, ref: 'Area', required: true },
            travelFee: { type: Number, default: 0, validate: piastresValidator },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    services: {
      type: [
        new Schema(
          {
            serviceId: { type: Schema.Types.ObjectId, ref: 'CatalogService', required: true },
            price: { type: Number, required: true, validate: piastresValidator },
            isActive: { type: Boolean, default: true },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    availability: {
      type: [
        new Schema(
          {
            dayOfWeek: { type: Number, min: 0, max: 6, required: true },
            startTime: { type: String, required: true },
            endTime: { type: String, required: true },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    ratingAvg: { type: Number, default: 0 },
    ratingCount: { type: Number, default: 0 },
    completedVisitsCount: { type: Number, default: 0 },
    isAcceptingBookings: { type: Boolean, default: false },
    isTestAccount: { type: Boolean, default: false },
    // Bumped inside every booking transaction for this provider: concurrent ones then conflict, and the
    // retry sees the other booking — this is what prevents double booking (see booking-transaction.ts).
    scheduleVersion: { type: Number, default: 0 },
  },
  { ...baseSchemaOptions, toJSON: { getters: true }, toObject: { getters: true } },
);

providerProfileSchema.plugin(softDeletePlugin);
providerProfileSchema.index({ userId: 1 }, uniqueAmongActive);
// Admin verification queue: oldest submissions first.
providerProfileSchema.index({ verificationStatus: 1, submittedAt: 1 });
// Search (M1.5): bookable providers by area. MongoDB can't index two arrays together, so services are filtered after.
providerProfileSchema.index({ verificationStatus: 1, isAcceptingBookings: 1, 'serviceAreas.areaId': 1 });
providerProfileSchema.index({ organizationId: 1 });

export const ProviderProfileModel = model<IProviderProfile, ProviderProfileModelType>(
  'ProviderProfile',
  providerProfileSchema,
);
