import { describe, expect, it } from 'vitest';
import { durationMinutes, slotsForDay } from '../../src/services/discovery/slot-engine';
import { PricingUnit } from '../../src/interfaces/enums';
import { cairoToUtc } from '../../src/utils/time/cairo';

// 2026-01-04 is a Sunday (day 0) in winter (UTC+2).
const SUNDAY = '2026-01-04';
const availability = [{ dayOfWeek: 0, startTime: '09:00', endTime: '12:00' }];
const longAgo = new Date('2025-01-01T00:00:00Z');
const base = { availability, date: SUNDAY, defaultDurationMinutes: 45, quantity: 1, busy: [], now: longAgo };
const times = (slots: Array<{ start: Date }>) => slots.map((s) => s.start.toISOString().slice(11, 16));

describe('slotsForDay', () => {
  it('per visit: a start every 30 min that still ends inside the window (UTC output)', () => {
    const slots = slotsForDay({ ...base, pricingUnit: PricingUnit.PER_VISIT });
    // 09:00 … 11:00 Cairo (11:30 + 45 min would end after 12:00) → 07:00 … 09:00 UTC
    expect(times(slots)).toEqual(['07:00', '07:30', '08:00', '08:30', '09:00']);
    expect(slots[0].end.getTime() - slots[0].start.getTime()).toBe(45 * 60_000);
    expect(slots.every((s) => s.available)).toBe(true);
  });

  it('per hour: the duration grows with the quantity', () => {
    const slots = slotsForDay({ ...base, pricingUnit: PricingUnit.PER_HOUR, quantity: 2 });
    expect(times(slots)).toEqual(['07:00', '07:30', '08:00']); // 09:00–11:00 … 10:00–12:00 Cairo
  });

  it('per day: one slot per working window, lasting quantity × 24 h', () => {
    const slots = slotsForDay({ ...base, pricingUnit: PricingUnit.PER_DAY, quantity: 3 });
    expect(slots).toHaveLength(1);
    expect(slots[0].end.getTime() - slots[0].start.getTime()).toBe(3 * 24 * 3600_000);
  });

  it('marks slots that clash with busy time as unavailable', () => {
    const busy = [{ start: cairoToUtc(SUNDAY, '10:00'), end: cairoToUtc(SUNDAY, '10:30') }];
    const slots = slotsForDay({ ...base, pricingUnit: PricingUnit.PER_VISIT, busy });
    expect(slots.map((s) => s.available)).toEqual([true, false, false, true, true]);
    // 09:30–10:15 and 10:00–10:45 clash; 09:00–09:45 and 10:30–11:15 don't.
  });

  it('leaves out starts sooner than 60 minutes from now', () => {
    const now = cairoToUtc(SUNDAY, '09:10');
    const slots = slotsForDay({ ...base, pricingUnit: PricingUnit.PER_VISIT, now });
    expect(times(slots)).toEqual(['08:30', '09:00']); // 10:30 and 11:00 Cairo
  });

  it('other weekdays have no slots', () => {
    expect(slotsForDay({ ...base, date: '2026-01-05', pricingUnit: PricingUnit.PER_VISIT })).toEqual([]);
  });

  it('summer dates use UTC+3', () => {
    const slots = slotsForDay({ ...base, date: '2026-07-05', pricingUnit: PricingUnit.PER_VISIT });
    expect(times(slots)[0]).toBe('06:00');
  });
});

describe('durationMinutes', () => {
  it('per pricing unit', () => {
    expect(durationMinutes(PricingUnit.PER_VISIT, 45, 3)).toBe(45);
    expect(durationMinutes(PricingUnit.PER_HOUR, 45, 3)).toBe(180);
    expect(durationMinutes(PricingUnit.PER_DAY, 45, 2)).toBe(2880);
  });
});
