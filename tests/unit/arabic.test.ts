import { describe, expect, it } from 'vitest';
import { escapeRegExp, normalizeSearchText } from '../../src/utils/text/arabic';

describe('normalizeSearchText', () => {
  it.each([
    ['مدينة نصر', 'مدينه نصر'],
    ['المعادى', 'المعادي'],
    ['الإسكندرية', 'الاسكندريه'],
    ['أكتوبر', 'اكتوبر'],
    ['مُحَرَّم بك', 'محرم بك'],
    ['  Nasr   City ', 'nasr city'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeSearchText(input)).toBe(expected);
  });

  it('makes spelling variants equal', () => {
    expect(normalizeSearchText('مدينه نصر')).toBe(normalizeSearchText('مدينة نصر'));
  });
});

describe('escapeRegExp', () => {
  it('neutralizes regex syntax in user input', () => {
    expect(new RegExp(escapeRegExp('a.*(b)')).test('a.*(b)')).toBe(true);
    expect(new RegExp(escapeRegExp('a.*')).test('abc')).toBe(false);
  });
});
