/**
 * Normalizes text for search so common Arabic spelling variants match each other:
 * "مدينه نصر" finds "مدينة نصر", "اسكندرية" finds "الإسكندرية" (via substring), "المعادى" finds "المعادي".
 */
export const normalizeSearchText = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[ً-ْٰـ]/g, '') // tashkeel, superscript alef, tatweel
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/\s+/g, ' ')
    .trim();

/** Escapes user input for use inside a RegExp. */
export const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
