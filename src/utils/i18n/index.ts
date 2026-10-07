import type { Request } from 'express';
import ar from '../../locales/ar.json';
import en from '../../locales/en.json';

/**
 * Translation catalogs live in `src/locales/<lang>.json`. Arabic is the launch language and the
 * source of truth: every key must exist in `ar.json`, and any key missing from another catalog
 * falls back to Arabic. Adding English = filling `en.json`, no code changes.
 */
type Catalog = { [key: string]: string | Catalog };

export const SUPPORTED_LANGUAGES = ['ar', 'en'] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number];
export const DEFAULT_LANGUAGE: Language = 'ar';

const catalogs: Record<Language, Catalog> = { ar, en };

/** Dot-paths to every string in `ar.json`, e.g. `'errors.NOT_FOUND'`. */
type Leaves<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${Prefix}${K}` : Leaves<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

export type TranslationKey = Leaves<typeof ar>;
export type TranslationParams = Record<string, string | number>;

const lookup = (catalog: Catalog, key: string): string | undefined => {
  let node: string | Catalog | undefined = catalog;
  for (const part of key.split('.')) {
    if (typeof node !== 'object') return undefined;
    node = node[part];
  }
  return typeof node === 'string' ? node : undefined;
};

const interpolate = (text: string, params?: TranslationParams) =>
  params ? text.replace(/\{\{(\w+)\}\}/g, (match, name: string) => String(params[name] ?? match)) : text;

/** Translates a key, filling `{{name}}` placeholders from `params`. Falls back to Arabic, then to the key. */
export const t = (
  key: TranslationKey,
  params?: TranslationParams,
  lang: Language = DEFAULT_LANGUAGE,
): string => {
  const text = lookup(catalogs[lang], key) ?? lookup(catalogs[DEFAULT_LANGUAGE], key) ?? key;
  return interpolate(text, params);
};

/** Like `t`, for strings that may or may not be keys (e.g. validator messages): unknown text is returned as-is. */
export const translateIfKey = (text: string, lang: Language = DEFAULT_LANGUAGE): string =>
  lookup(catalogs[lang], text) ?? lookup(catalogs[DEFAULT_LANGUAGE], text) ?? text;

const isSupported = (lang: string): lang is Language =>
  (SUPPORTED_LANGUAGES as readonly string[]).includes(lang);

/** Highest-weighted supported language in an `Accept-Language` header, e.g. `'ar-EG,ar;q=0.9,en;q=0.8'` → `'ar'`. */
export const parseAcceptLanguage = (header: string | undefined): Language | undefined =>
  header
    ?.split(',')
    .map((part) => {
      const [tag, ...attrs] = part.trim().split(';');
      const q = attrs.find((a) => a.trim().startsWith('q='));
      return { lang: tag.trim().split('-')[0].toLowerCase(), q: q ? Number(q.trim().slice(2)) : 1 };
    })
    .filter(({ lang, q }) => isSupported(lang) && q > 0)
    .sort((a, b) => b.q - a.q)[0]?.lang as Language | undefined;

/** Request language: `Accept-Language` → the user's saved language → Arabic. */
export const resolveLanguage = (req: Request): Language =>
  parseAcceptLanguage(req.headers['accept-language']) ?? req.user?.language ?? DEFAULT_LANGUAGE;
