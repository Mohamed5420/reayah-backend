import { Schema, model, type Model } from 'mongoose';
import {
  BannerAction,
  BroadcastStatus,
  BroadcastType,
  PackageSubscriptionStatus,
  PromoType,
  ReferralStatus,
  type IBanner,
  type IBroadcast,
  type IPackage,
  type IPackageSubscription,
  type IPromoCode,
  type IPromoRedemption,
  type IReferral,
} from '../../../interfaces/IMarketing';
import { baseSchemaOptions, piastresValidator, uniqueAmongActive } from '../../schema-options';
import { softDeletePlugin, type SoftDeleteMethods } from '../../plugins/soft-delete.plugin';

const money = { type: Number, required: true, validate: piastresValidator };

// ── Packages ──

type PackageModelType = Model<IPackage, object, SoftDeleteMethods>;

const packageSchema = new Schema<IPackage, PackageModelType, SoftDeleteMethods>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', default: null },
    nameAr: { type: String, required: true, trim: true },
    nameEn: { type: String, trim: true, default: null },
    descriptionAr: { type: String, default: null },
    descriptionEn: { type: String, default: null },
    serviceId: { type: Schema.Types.ObjectId, ref: 'CatalogService', required: true },
    visitsCount: { type: Number, required: true, min: 1 },
    validityDays: { type: Number, required: true, min: 1 },
    price: money,
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
  },
  baseSchemaOptions,
);
packageSchema.plugin(softDeletePlugin);
packageSchema.index({ isActive: 1, serviceId: 1, sortOrder: 1 });
packageSchema.index({ organizationId: 1 });

export const PackageModel = model<IPackage, PackageModelType>('Package', packageSchema);

/** Purchases are financial records: no soft delete. */
const packageSubscriptionSchema = new Schema<IPackageSubscription>(
  {
    packageId: { type: Schema.Types.ObjectId, ref: 'Package', required: true },
    patientUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    patientProfileId: { type: Schema.Types.ObjectId, ref: 'PatientProfile', required: true },
    package: {
      nameAr: { type: String, required: true },
      nameEn: { type: String, default: null },
      organizationId: { type: Schema.Types.ObjectId, default: null },
      serviceId: { type: Schema.Types.ObjectId, required: true },
      visitsCount: { type: Number, required: true },
      validityDays: { type: Number, required: true },
      price: money,
      perVisitValue: money,
    },
    status: {
      type: String,
      enum: Object.values(PackageSubscriptionStatus),
      default: PackageSubscriptionStatus.PENDING_PAYMENT,
    },
    visitsRemaining: { type: Number, required: true, min: 0 },
    visitsReserved: { type: Number, default: 0, min: 0 },
    startsAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
    paymentId: { type: Schema.Types.ObjectId, ref: 'Payment', default: null },
    expiryNoticeAt: { type: Date, default: null },
    lowVisitsNoticeAt: { type: Date, default: null },
  },
  baseSchemaOptions,
);
packageSubscriptionSchema.index({ patientUserId: 1, status: 1, expiresAt: 1 });
// Expiry job + unpaid sweep.
packageSubscriptionSchema.index({ status: 1, expiresAt: 1 });
packageSubscriptionSchema.index({ status: 1, createdAt: 1 });

export const PackageSubscriptionModel = model<IPackageSubscription>(
  'PackageSubscription',
  packageSubscriptionSchema,
);

// ── Promo codes ──

type PromoCodeModelType = Model<IPromoCode, object, SoftDeleteMethods>;

const promoCodeSchema = new Schema<IPromoCode, PromoCodeModelType, SoftDeleteMethods>(
  {
    code: { type: String, required: true, trim: true, uppercase: true },
    descriptionAr: { type: String, default: null },
    descriptionEn: { type: String, default: null },
    type: { type: String, enum: Object.values(PromoType), required: true },
    value: { type: Number, required: true, min: 1 },
    maxDiscount: { type: Number, default: null, validate: piastresValidator },
    minSubtotal: { type: Number, default: 0, validate: piastresValidator },
    maxUses: { type: Number, default: null, min: 1 },
    perUserLimit: { type: Number, default: 1, min: 1 },
    usesCount: { type: Number, default: 0, min: 0 },
    validFrom: { type: Date, default: null },
    validTo: { type: Date, default: null },
    serviceIds: { type: [Schema.Types.ObjectId], default: [] },
    firstBookingOnly: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
  },
  baseSchemaOptions,
);
promoCodeSchema.plugin(softDeletePlugin);
promoCodeSchema.index({ code: 1 }, uniqueAmongActive);

export const PromoCodeModel = model<IPromoCode, PromoCodeModelType>('PromoCode', promoCodeSchema);

const promoRedemptionSchema = new Schema<IPromoRedemption>(
  {
    promoCodeId: { type: Schema.Types.ObjectId, ref: 'PromoCode', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true, unique: true },
    discount: money,
    status: { type: String, enum: ['active', 'released'], default: 'active' },
  },
  baseSchemaOptions,
);
promoRedemptionSchema.index({ promoCodeId: 1, userId: 1, status: 1 });

export const PromoRedemptionModel = model<IPromoRedemption>(
  'PromoRedemption',
  promoRedemptionSchema,
  'promo_redemptions',
);

// ── Referrals ──

const referralSchema = new Schema<IReferral>(
  {
    referrerUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    referredUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    referredPhoneHash: { type: String, required: true, unique: true },
    code: { type: String, required: true },
    status: { type: String, enum: Object.values(ReferralStatus), default: ReferralStatus.PENDING },
    rewardAmount: { type: Number, default: 0, validate: piastresValidator },
    rewardedAt: { type: Date, default: null },
  },
  baseSchemaOptions,
);

export const ReferralModel = model<IReferral>('Referral', referralSchema);

// ── Banners ──

type BannerModelType = Model<IBanner, object, SoftDeleteMethods>;

const bannerSchema = new Schema<IBanner, BannerModelType, SoftDeleteMethods>(
  {
    titleAr: { type: String, trim: true, default: null },
    titleEn: { type: String, trim: true, default: null },
    imageKey: { type: String, required: true },
    action: { type: String, enum: Object.values(BannerAction), default: BannerAction.NONE },
    value: { type: String, default: null },
    sortOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    startsAt: { type: Date, default: null },
    endsAt: { type: Date, default: null },
  },
  baseSchemaOptions,
);
bannerSchema.plugin(softDeletePlugin);
bannerSchema.index({ isActive: 1, sortOrder: 1 });

export const BannerModel = model<IBanner, BannerModelType>('Banner', bannerSchema);

// ── Broadcasts ──

const broadcastSchema = new Schema<IBroadcast>(
  {
    type: { type: String, enum: Object.values(BroadcastType), required: true },
    title: { type: String, required: true, trim: true },
    body: { type: String, required: true, trim: true },
    reason: { type: String, default: null },
    segment: {
      role: { type: String, enum: ['patient', 'provider', 'provider_staff', 'owner', null], default: null },
      areaIds: { type: [Schema.Types.ObjectId], ref: 'Area', default: [] },
    },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    day: { type: String, required: true },
    seq: { type: Number, required: true },
    status: { type: String, enum: Object.values(BroadcastStatus), default: BroadcastStatus.QUEUED },
    audience: { type: Number, default: 0 },
    sentCount: { type: Number, default: 0 },
    cursor: { type: Schema.Types.ObjectId, default: null },
    lockedUntil: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
  },
  baseSchemaOptions,
);
broadcastSchema.plugin(softDeletePlugin);
// The daily cap: one record per (type, Cairo day, n).
broadcastSchema.index({ type: 1, day: 1, seq: 1 }, { unique: true });
broadcastSchema.index({ status: 1, lockedUntil: 1 });
broadcastSchema.index({ createdAt: -1 });

export const BroadcastModel = model<IBroadcast>('Broadcast', broadcastSchema);
