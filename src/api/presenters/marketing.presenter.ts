import {
  perVisitValue,
  type IBanner,
  type IBroadcast,
  type IPackage,
  type IPackageSubscription,
  type IPromoCode,
} from '../../interfaces/IMarketing';
import { t, type Language } from '../../utils/i18n';
import { adminMeta, localized, localizedOrNull } from './localize';

/** Maps packages, promo codes and banners to the API shapes in marketing.validation.ts. */

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export const presentPackage = (
  pkg: IPackage,
  service: { id: string; nameAr: string; nameEn: string | null },
  lang: Language,
  organization: { id: string; name: string } | null = null,
) => ({
  id: String(pkg._id),
  name: localized(pkg.nameAr, pkg.nameEn, lang),
  description: localizedOrNull(pkg.descriptionAr, pkg.descriptionEn, lang),
  service: { id: service.id, name: localized(service.nameAr, service.nameEn, lang) },
  visit_type: pkg.visitType ?? 'home_visit',
  visits_count: pkg.visitsCount,
  validity_days: pkg.validityDays,
  price: pkg.price,
  per_visit_value: perVisitValue(pkg),
  currency: 'EGP' as const,
  /** An organization's package: book that organization with it. null = a platform package. */
  organization,
  travel_fee_included: false as const,
  travel_fee_note: t('packages.travel_fee_note', {}, lang),
});

export const presentSubscription = (sub: IPackageSubscription, lang: Language) => ({
  id: String(sub._id),
  package: { id: String(sub.packageId), name: localized(sub.package.nameAr, sub.package.nameEn, lang) },
  service_id: String(sub.package.serviceId),
  patient_profile_id: String(sub.patientProfileId),
  status: sub.status,
  visits_total: sub.package.visitsCount,
  visits_remaining: sub.visitsRemaining,
  visits_booked: sub.visitsReserved,
  per_visit_value: sub.package.perVisitValue,
  starts_at: iso(sub.startsAt),
  expires_at: iso(sub.expiresAt),
  payment_id: sub.paymentId ? String(sub.paymentId) : null,
  created_at: sub.createdAt.toISOString(),
});

export const presentAdminPromo = (p: IPromoCode) => ({
  ...adminMeta(p),
  code: p.code,
  description_ar: p.descriptionAr,
  description_en: p.descriptionEn,
  type: p.type,
  value: p.value,
  max_discount: p.maxDiscount,
  min_subtotal: p.minSubtotal,
  max_uses: p.maxUses,
  per_user_limit: p.perUserLimit,
  uses_count: p.usesCount,
  valid_from: iso(p.validFrom),
  valid_to: iso(p.validTo),
  service_ids: p.serviceIds.map(String),
  visit_types: p.visitTypes ?? [],
  first_booking_only: p.firstBookingOnly,
  is_active: p.isActive,
});

export const presentAdminPackage = (p: IPackage & { soldCount: number }) => ({
  ...adminMeta(p),
  name_ar: p.nameAr,
  name_en: p.nameEn,
  description_ar: p.descriptionAr,
  description_en: p.descriptionEn,
  service_id: String(p.serviceId),
  visit_type: p.visitType ?? 'home_visit',
  visits_count: p.visitsCount,
  validity_days: p.validityDays,
  price: p.price,
  per_visit_value: perVisitValue(p),
  is_active: p.isActive,
  sort_order: p.sortOrder,
  sold_count: p.soldCount,
});

export const presentBroadcast = (b: IBroadcast) => ({
  id: String(b._id),
  type: b.type,
  title: b.title,
  body: b.body,
  reason: b.reason,
  segment: { role: b.segment.role, area_ids: b.segment.areaIds.map(String) },
  created_by: String(b.createdBy),
  status: b.status,
  audience: b.audience,
  sent_count: b.sentCount,
  finished_at: b.finishedAt?.toISOString() ?? null,
  created_at: b.createdAt.toISOString(),
});

export const presentAdminBanner = (b: IBanner, imageUrl: string) => ({
  ...adminMeta(b),
  title_ar: b.titleAr,
  title_en: b.titleEn,
  image_url: imageUrl,
  action: b.action,
  value: b.value,
  sort_order: b.sortOrder,
  is_active: b.isActive,
  starts_at: iso(b.startsAt),
  ends_at: iso(b.endsAt),
});

/** Home screen banner (spec §7.3). */
export const presentHomeBanner = (
  b: { _id: unknown; titleAr: string | null; titleEn: string | null; action: string; value: string | null },
  imageUrl: string,
  lang: Language,
) => ({
  id: String(b._id),
  title: b.titleAr ? localized(b.titleAr, b.titleEn, lang) : null,
  image_url: imageUrl,
  action: b.action,
  value: b.value,
});
