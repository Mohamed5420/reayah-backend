import { PaymentMethod } from '../../../interfaces/IBooking';
import { BannerAction, PackageSubscriptionStatus, PromoType } from '../../../interfaces/IMarketing';
import { booleanQuery, nameAr, nameEn, objectId, paginationQuery, piastres, timestamps, z } from '../zod';

const instant = z.iso.datetime({ offset: true }).openapi({ example: '2026-10-05T14:00:00Z' });
const description = z.string().trim().max(500).nullable();

const packageView = z
  .object({
    id: objectId,
    name: z.string(),
    description: z.string().nullable(),
    service: z.object({ id: objectId, name: z.string() }),
    visits_count: z.number(),
    validity_days: z.number(),
    price: z.number(),
    /** price ÷ visits: only providers at or below this price can be booked with the package. */
    per_visit_value: z.number(),
    currency: z.literal('EGP'),
    /** An organization's package (book that organization with it); null for a platform package. */
    organization: z.object({ id: objectId, name: z.string() }).nullable(),
    /** Always false: the travel fee is paid with each visit. Show travel_fee_note with the price. */
    travel_fee_included: z.literal(false),
    travel_fee_note: z.string(),
  })
  .openapi('Package');

const subscriptionView = z
  .object({
    id: objectId,
    package: z.object({ id: objectId, name: z.string() }),
    service_id: objectId,
    patient_profile_id: objectId,
    status: z.enum(PackageSubscriptionStatus),
    visits_total: z.number(),
    visits_remaining: z.number(),
    /** Held by upcoming bookings; free = remaining − booked. */
    visits_booked: z.number(),
    per_visit_value: z.number(),
    starts_at: z.string().nullable(),
    expires_at: z.string().nullable(),
    /** The purchase checkout, for an unpaid one. */
    payment_id: objectId.nullable(),
    created_at: z.string(),
  })
  .openapi('PackageSubscription');

const promoBody = z.strictObject({
  code: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{2,32}$/, { error: 'validation.promo_code_format' }),
  description_ar: description.optional(),
  description_en: description.optional(),
  type: z.enum(PromoType),
  /** percent: 1–100; fixed: piastres. */
  value: z.number().int().min(1),
  max_discount: piastres.nullable().optional(),
  min_subtotal: piastres.optional(),
  max_uses: z.number().int().min(1).nullable().optional(),
  per_user_limit: z.number().int().min(1).optional(),
  valid_from: instant.nullable().optional(),
  valid_to: instant.nullable().optional(),
  service_ids: z.array(objectId).max(100).optional(),
  first_booking_only: z.boolean().optional(),
  is_active: z.boolean().optional(),
});

const adminPromo = z
  .object({
    id: objectId,
    code: z.string(),
    description_ar: z.string().nullable(),
    description_en: z.string().nullable(),
    type: z.enum(PromoType),
    value: z.number(),
    max_discount: z.number().nullable(),
    min_subtotal: z.number(),
    max_uses: z.number().nullable(),
    per_user_limit: z.number(),
    uses_count: z.number(),
    valid_from: z.string().nullable(),
    valid_to: z.string().nullable(),
    service_ids: z.array(objectId),
    first_booking_only: z.boolean(),
    is_active: z.boolean(),
    ...timestamps,
  })
  .openapi('AdminPromoCode');

const packageBody = z.strictObject({
  name_ar: nameAr,
  name_en: nameEn.optional(),
  description_ar: description.optional(),
  description_en: description.optional(),
  service_id: objectId,
  visits_count: z.number().int().min(1).max(100),
  validity_days: z.number().int().min(1).max(730),
  price: piastres.min(100),
  is_active: z.boolean().optional(),
  sort_order: z.number().int().optional(),
});

const adminPackage = z
  .object({
    id: objectId,
    name_ar: z.string(),
    name_en: z.string().nullable(),
    description_ar: z.string().nullable(),
    description_en: z.string().nullable(),
    service_id: objectId,
    visits_count: z.number(),
    validity_days: z.number(),
    price: z.number(),
    per_visit_value: z.number(),
    is_active: z.boolean(),
    sort_order: z.number(),
    /** Paid subscriptions so far. */
    sold_count: z.number(),
    ...timestamps,
  })
  .openapi('AdminPackage');

const bannerBody = z.strictObject({
  title_ar: z.string().trim().max(100).nullable().optional(),
  title_en: z.string().trim().max(100).nullable().optional(),
  /** From POST /uploads with purpose `banner` (JPG / PNG). */
  image_key: z.string().min(1).max(300),
  action: z.enum(BannerAction).optional(),
  /** Promo code, service / category / package id, or https link — depending on `action`; null for none. */
  value: z.string().trim().max(500).nullable().optional(),
  sort_order: z.number().int().optional(),
  is_active: z.boolean().optional(),
  starts_at: instant.nullable().optional(),
  ends_at: instant.nullable().optional(),
});

const adminBanner = z
  .object({
    id: objectId,
    title_ar: z.string().nullable(),
    title_en: z.string().nullable(),
    image_url: z.string(),
    action: z.enum(BannerAction),
    value: z.string().nullable(),
    sort_order: z.number(),
    is_active: z.boolean(),
    starts_at: z.string().nullable(),
    ends_at: z.string().nullable(),
    ...timestamps,
  })
  .openapi('AdminBanner');

/** Packages, promo codes, referrals and banners (spec §7.9, §7.2 /me/referral, §7.15 marketing). */
export const MarketingSchemas = {
  idParams: z.object({ id: objectId }),

  packagesQuery: z.object({ service_id: objectId.optional(), area_id: objectId.optional() }),
  package: packageView,
  subscribeBody: z
    .strictObject({
      patient_profile_id: objectId,
      /** Packages are paid upfront by card or wallet (no cash). */
      payment_method: z.enum([PaymentMethod.CARD, PaymentMethod.WALLET]),
    })
    .openapi('SubscribePackage'),
  subscribed: z
    .object({
      subscription_id: objectId,
      /** Shown on the purchase screen: the price doesn't include the per-visit travel fee. */
      travel_fee_note: z.string(),
      /** Open checkout_url and pay before expires_at; null if the gateway was unreachable (retry with POST /payments/initiate). */
      payment_action: z
        .object({ payment_id: objectId, checkout_url: z.string(), expires_at: z.string() })
        .nullable(),
    })
    .openapi('PackageSubscribed'),
  subscription: subscriptionView,
  subscriptionsQuery: paginationQuery,

  validatePromoBody: z
    .strictObject({
      code: z.string().trim().min(1).max(32),
      service_id: objectId,
      subtotal: piastres,
    })
    .openapi('ValidatePromo'),
  promoValidation: z
    .object({ valid: z.literal(true), discount: z.number(), description: z.string().nullable() })
    .openapi('PromoValidation'),

  referral: z
    .object({
      code: z.string().openapi({ example: 'AHMED25' }),
      share_url: z.string(),
      invited_count: z.number(),
      /** Referral rewards received so far (piastres). */
      rewards_earned: z.number(),
      /** Unspent credit, applied automatically to the next bookings (patients). */
      credit_balance: z.number(),
    })
    .openapi('Referral'),

  // Admin
  adminPromoQuery: paginationQuery.extend({
    is_active: booleanQuery.optional(),
    search: z.string().trim().max(32).optional(),
  }),
  createPromoBody: promoBody.openapi('CreatePromoCode'),
  updatePromoBody: promoBody.partial().openapi('UpdatePromoCode'),
  adminPromo,

  adminPackagesQuery: paginationQuery.extend({ is_active: booleanQuery.optional() }),
  createPackageBody: packageBody.openapi('CreatePackage'),
  updatePackageBody: packageBody.partial().openapi('UpdatePackage'),
  adminPackage,

  createBannerBody: bannerBody.openapi('CreateBanner'),
  updateBannerBody: bannerBody.partial().openapi('UpdateBanner'),
  adminBanner,
};
