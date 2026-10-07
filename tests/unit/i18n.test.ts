import { describe, expect, it } from 'vitest';
import { parseAcceptLanguage, t, translateIfKey } from '../../src/utils/i18n';

describe('parseAcceptLanguage', () => {
  it.each([
    ['ar', 'ar'],
    ['ar-EG,ar;q=0.9,en;q=0.8', 'ar'],
    ['en-US,en;q=0.9,ar;q=0.8', 'en'],
    ['fr;q=1, ar-EG;q=0.5', 'ar'],
    ['ar;q=0, en', 'en'],
  ])('%s → %s', (header, expected) => {
    expect(parseAcceptLanguage(header)).toBe(expected);
  });

  it.each([['de'], [''], [undefined]])('unsupported or missing (%s) → undefined', (header) => {
    expect(parseAcceptLanguage(header)).toBeUndefined();
  });
});

describe('t', () => {
  it('translates to Arabic by default', () => {
    expect(t('errors.NOT_FOUND')).toBe('غير موجود');
  });

  it('falls back to Arabic for keys missing from another catalog', () => {
    expect(t('errors.NOT_FOUND', undefined, 'en')).toBe('غير موجود');
  });

  it('translateIfKey returns unknown text unchanged', () => {
    expect(translateIfKey('validation.invalid_value')).toBe('قيمة غير صالحة');
    expect(translateIfKey('free text')).toBe('free text');
  });
});
