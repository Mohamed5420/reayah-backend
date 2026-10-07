import type { Language } from '../../utils/i18n';

/**
 * Doctor specialties (spec §4.4 `specialty`, M2.1). A fixed list so patients can filter by it; the
 * profile stores the key. Names follow what patients search for in Egypt. To add one, append here —
 * keys are stored in profiles, so never rename or remove a key.
 */
export const SPECIALTIES = [
  { key: 'general_practice', nameAr: 'ممارس عام', nameEn: 'General practice' },
  { key: 'family_medicine', nameAr: 'طب الأسرة', nameEn: 'Family medicine' },
  { key: 'internal_medicine', nameAr: 'باطنة', nameEn: 'Internal medicine' },
  { key: 'geriatrics', nameAr: 'طب المسنين', nameEn: 'Geriatrics' },
  { key: 'pediatrics', nameAr: 'أطفال', nameEn: 'Pediatrics' },
  { key: 'cardiology', nameAr: 'قلب وأوعية دموية', nameEn: 'Cardiology' },
  { key: 'chest', nameAr: 'صدر', nameEn: 'Chest medicine' },
  { key: 'endocrinology', nameAr: 'غدد صماء وسكر', nameEn: 'Endocrinology and diabetes' },
  { key: 'nephrology', nameAr: 'كلى', nameEn: 'Nephrology' },
  { key: 'neurology', nameAr: 'مخ وأعصاب', nameEn: 'Neurology' },
  { key: 'orthopedics', nameAr: 'عظام', nameEn: 'Orthopedics' },
  { key: 'dermatology', nameAr: 'جلدية', nameEn: 'Dermatology' },
  { key: 'urology', nameAr: 'مسالك بولية', nameEn: 'Urology' },
  { key: 'obstetrics_gynecology', nameAr: 'نساء وتوليد', nameEn: 'Obstetrics and gynecology' },
  { key: 'psychiatry', nameAr: 'نفسية', nameEn: 'Psychiatry' },
  { key: 'palliative_care', nameAr: 'رعاية تلطيفية', nameEn: 'Palliative care' },
] as const;

export type SpecialtyKey = (typeof SPECIALTIES)[number]['key'];
export const SPECIALTY_KEYS = SPECIALTIES.map((s) => s.key) as [SpecialtyKey, ...SpecialtyKey[]];

const byKey = new Map<string, (typeof SPECIALTIES)[number]>(SPECIALTIES.map((s) => [s.key, s]));

/** `{ key, name }` in the requested language, or null (nurses, or an unknown legacy value). */
export const presentSpecialty = (key: string | null | undefined, lang: Language = 'ar') => {
  const specialty = key ? byKey.get(key) : undefined;
  if (!specialty) return null;
  return { key: specialty.key, name: lang === 'en' ? specialty.nameEn : specialty.nameAr };
};
