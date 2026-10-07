import { describe, expect, it } from 'vitest';
import {
  addDays,
  cairoDate,
  cairoOffsetMinutes,
  cairoToUtc,
  dayOfWeek,
  fromMinutes,
  toMinutes,
} from '../../src/utils/time/cairo';

describe('Cairo time', () => {
  it('uses UTC+2 in winter and UTC+3 in summer (DST is back since 2023)', () => {
    expect(cairoOffsetMinutes(new Date('2026-01-15T12:00:00Z'))).toBe(120);
    expect(cairoOffsetMinutes(new Date('2026-07-15T12:00:00Z'))).toBe(180);
  });

  it('converts Cairo wall time to UTC with the right offset for that date', () => {
    expect(cairoToUtc('2026-01-15', '09:00').toISOString()).toBe('2026-01-15T07:00:00.000Z');
    expect(cairoToUtc('2026-07-15', '09:00').toISOString()).toBe('2026-07-15T06:00:00.000Z');
  });

  it('round-trips through the calendar date around midnight', () => {
    // 23:30 Cairo on Jan 15 is still Jan 15 locally, though already 21:30 UTC.
    const late = cairoToUtc('2026-01-15', '23:30');
    expect(cairoDate(late)).toBe('2026-01-15');
    // 00:30 Cairo on Jan 16 is still Jan 15 in UTC.
    const early = cairoToUtc('2026-01-16', '00:30');
    expect(early.toISOString().slice(0, 10)).toBe('2026-01-15');
    expect(cairoDate(early)).toBe('2026-01-16');
  });

  it('calendar helpers', () => {
    expect(dayOfWeek('2026-10-04')).toBe(0); // a Sunday
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(toMinutes('09:30')).toBe(570);
    expect(fromMinutes(570)).toBe('09:30');
  });
});
