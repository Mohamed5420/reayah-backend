import type { ICatalogService, IServiceCategory } from '../../interfaces/ICatalog';
import type { CategoryRow, ServiceRow } from '../../services/catalog';
import type { Language } from '../../utils/i18n';
import { adminMeta, localized, localizedOrNull } from './localize';

/** Maps catalog rows/documents to the API shapes in catalog.validation.ts. */

export const presentCategory = (c: CategoryRow, lang: Language) => ({
  id: c.id,
  key: c.key,
  name: localized(c.nameAr, c.nameEn, lang),
  icon_url: c.iconUrl,
});

/** `startingPrices` from `CatalogService.startingPrices()`; null when no verified provider offers the service. */
export const presentService = (s: ServiceRow, lang: Language, startingPrices: Record<string, number>) => ({
  id: s.id,
  category_id: s.categoryId,
  name: localized(s.nameAr, s.nameEn, lang),
  description: localizedOrNull(s.descriptionAr, s.descriptionEn, lang),
  provider_type: s.providerType,
  pricing_unit: s.pricingUnit,
  default_duration_minutes: s.defaultDurationMinutes,
  starting_price: startingPrices[s.id] ?? null,
  currency: 'EGP' as const,
});

export const presentAdminCategory = (c: IServiceCategory) => ({
  ...adminMeta(c),
  key: c.key,
  name_ar: c.nameAr,
  name_en: c.nameEn,
  icon_url: c.iconUrl,
  is_active: c.isActive,
  sort_order: c.sortOrder,
});

export const presentAdminService = (s: ICatalogService) => ({
  ...adminMeta(s),
  category_id: String(s.categoryId),
  name_ar: s.nameAr,
  name_en: s.nameEn,
  description_ar: s.descriptionAr,
  description_en: s.descriptionEn,
  provider_type: s.providerType,
  pricing_unit: s.pricingUnit,
  default_duration_minutes: s.defaultDurationMinutes,
  min_price: s.minPrice,
  max_price: s.maxPrice,
  is_active: s.isActive,
  sort_order: s.sortOrder,
});
