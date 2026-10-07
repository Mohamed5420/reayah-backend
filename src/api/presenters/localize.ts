import type { Language } from '../../utils/i18n';

/**
 * Picks the text for the request language. Arabic is the source of truth; English is used only
 * when requested and filled in (spec §10: `name_en` stays nullable until English launches).
 */
export const localized = (ar: string, en: string | null, lang: Language): string =>
  lang === 'en' && en ? en : ar;

export const localizedOrNull = (ar: string | null, en: string | null, lang: Language): string | null =>
  lang === 'en' && en ? en : ar;

/** Shared fields of admin resources. Works with lean and hydrated documents. */
export const adminMeta = (doc: { _id: unknown; createdAt: Date; updatedAt: Date }) => ({
  id: String(doc._id),
  created_at: doc.createdAt.toISOString(),
  updated_at: doc.updatedAt.toISOString(),
});
