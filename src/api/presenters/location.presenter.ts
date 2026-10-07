import type { IArea, IGovernorate } from '../../interfaces/ILocation';
import type { AreaRow, GovernorateRow } from '../../services/location';
import type { Language } from '../../utils/i18n';
import { adminMeta, localized } from './localize';

/** Maps location rows/documents to the API shapes in location.validation.ts. */

export const presentGovernorate = (g: GovernorateRow, lang: Language) => ({
  id: g.id,
  name: localized(g.nameAr, g.nameEn, lang),
});

export const presentArea = (a: AreaRow, lang: Language) => ({
  id: a.id,
  name: localized(a.nameAr, a.nameEn, lang),
  governorate_id: a.governorateId,
});

export const presentAreaSearchResult = (a: AreaRow & { governorate: GovernorateRow }, lang: Language) => ({
  ...presentArea(a, lang),
  governorate_name: localized(a.governorate.nameAr, a.governorate.nameEn, lang),
});

export const presentAdminGovernorate = (g: IGovernorate) => ({
  ...adminMeta(g),
  name_ar: g.nameAr,
  name_en: g.nameEn,
  is_active: g.isActive,
  sort_order: g.sortOrder,
});

export const presentAdminArea = (a: IArea) => ({
  ...adminMeta(a),
  governorate_id: String(a.governorateId),
  name_ar: a.nameAr,
  name_en: a.nameEn,
  is_active: a.isActive,
  max_travel_fee: a.maxTravelFee,
});
