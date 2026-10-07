import type { IAddress } from '../../interfaces/IAddress';
import type { AreaDescription } from '../location/location.service';
import { t, type Language } from '../../utils/i18n';

const pick = (ar: string, en: string | null, lang: Language) => (lang === 'en' && en ? en : ar);

/**
 * One-line address for display, providers and booking snapshots (spec §7.8 `full_text`):
 * "15 شارع عباس العقاد، الدور 4، شقة 12، مدينة نصر، القاهرة".
 */
export const addressFullText = (
  a: Pick<IAddress, 'building' | 'street' | 'floor' | 'apartment'>,
  place: AreaDescription | undefined,
  lang: Language,
) =>
  [
    [a.building, a.street].filter(Boolean).join(' '),
    a.floor ? t('address.floor', { floor: a.floor }, lang) : null,
    a.apartment ? t('address.apartment', { apartment: a.apartment }, lang) : null,
    place ? pick(place.area.nameAr, place.area.nameEn, lang) : null,
    place ? pick(place.governorate.nameAr, place.governorate.nameEn, lang) : null,
  ]
    .filter(Boolean)
    .join(t('address.separator', undefined, lang));
