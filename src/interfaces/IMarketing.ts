import type { Types } from 'mongoose';

/**
 * Spec §4.7 `packages`: a platform package (`organizationId` null) or an organization's own (M3.4). An
 * organization's package is booked with that organization only; it earns the per-visit value minus its
 * commission on each completed visit (decision M3.4).
 */
export interface IPackage {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId | null;
  nameAr: string;
  nameEn: string | null;
  descriptionAr: string | null;
  descriptionEn: string | null;
  serviceId: Types.ObjectId;
  visitsCount: number;
  validityDays: number;
  /** Piastres, for all visits. */
  price: number;
  isActive: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * What one visit of a package is worth (piastres, rounded down). Only providers whose own price is at
 * or below it can be booked with the package; any difference stays with the platform.
 */
export const perVisitValue = (p: Pick<IPackage, 'price' | 'visitsCount'>) =>
  Math.floor(p.price / p.visitsCount);

export enum PackageSubscriptionStatus {
  /** Bought, checkout not paid yet; cancelled by the payment sweep after card_payment_window_minutes. */
  PENDING_PAYMENT = 'pending_payment',
  ACTIVE = 'active',
  /** Every visit used. */
  USED_UP = 'used_up',
  EXPIRED = 'expired',
  /** Never paid. */
  CANCELLED = 'cancelled',
}

/** Spec §4.7 `package_subscriptions`. The package is snapshotted so later admin edits don't change it. */
export interface IPackageSubscription {
  _id: Types.ObjectId;
  packageId: Types.ObjectId;
  patientUserId: Types.ObjectId;
  patientProfileId: Types.ObjectId;
  package: {
    nameAr: string;
    nameEn: string | null;
    /** An organization's package: book that organization (the visit is priced at perVisitValue). */
    organizationId: Types.ObjectId | null;
    serviceId: Types.ObjectId;
    visitsCount: number;
    validityDays: number;
    price: number;
    perVisitValue: number;
  };
  status: PackageSubscriptionStatus;
  /** Decremented when a visit is completed (decision 7). */
  visitsRemaining: number;
  /** Visits held by active bookings; given back if the booking ends without a visit. */
  visitsReserved: number;
  startsAt: Date | null;
  expiresAt: Date | null;
  paymentId: Types.ObjectId | null;
  /** When "about to expire" / "one visit left" went out (once each). */
  expiryNoticeAt: Date | null;
  lowVisitsNoticeAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export enum PromoType {
  PERCENT = 'percent',
  FIXED = 'fixed',
}

/** Spec §4.10 `promo_codes`. Discounts come out of the platform's commission (product decision). */
export interface IPromoCode {
  _id: Types.ObjectId;
  /** Stored upper-case; matched case-insensitively. */
  code: string;
  descriptionAr: string | null;
  descriptionEn: string | null;
  type: PromoType;
  /** Percent (1–100) or piastres. */
  value: number;
  /** Percent codes: cap on the discount (piastres). */
  maxDiscount: number | null;
  /** Smallest subtotal the code applies to (piastres). */
  minSubtotal: number;
  /** Total uses across everyone; null = unlimited. */
  maxUses: number | null;
  perUserLimit: number;
  usesCount: number;
  validFrom: Date | null;
  validTo: Date | null;
  /** Empty = every service. */
  serviceIds: Types.ObjectId[];
  /** Only for patients without any earlier booking (cancelled / declined / expired ones don't count). */
  firstBookingOnly: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** One use of a promo code by a booking; released if the booking ends without a visit. */
export interface IPromoRedemption {
  _id: Types.ObjectId;
  promoCodeId: Types.ObjectId;
  userId: Types.ObjectId;
  bookingId: Types.ObjectId;
  discount: number;
  status: 'active' | 'released';
  createdAt: Date;
  updatedAt: Date;
}

export enum ReferralStatus {
  /** Waiting for the referred patient's first completed booking. */
  PENDING = 'pending',
  REWARDED = 'rewarded',
}

/** Spec §4.10 `referrals`. */
export interface IReferral {
  _id: Types.ObjectId;
  referrerUserId: Types.ObjectId;
  referredUserId: Types.ObjectId;
  /** HMAC of the referred phone: a number can be referred once, even after the account is deleted. */
  referredPhoneHash: string;
  code: string;
  status: ReferralStatus;
  /** Credit given to each side (piastres). */
  rewardAmount: number;
  rewardedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export enum BannerAction {
  NONE = 'none',
  PROMO = 'promo',
  SERVICE = 'service',
  CATEGORY = 'category',
  PACKAGE = 'package',
  URL = 'url',
}

/** Home screen banner (spec §7.3 `/home`, §7.15 marketing). */
export interface IBanner {
  _id: Types.ObjectId;
  titleAr: string | null;
  titleEn: string | null;
  /** Storage key (private bucket); shown through a signed URL. */
  imageKey: string;
  action: BannerAction;
  /** Promo code, service / category / package id, or https URL — depending on `action`. */
  value: string | null;
  sortOrder: number;
  isActive: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
