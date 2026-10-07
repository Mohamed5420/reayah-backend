import { PricingUnit } from '../../interfaces/enums';
import type { IAvailabilitySlot } from '../../interfaces/IProfiles';
import { cairoToUtc, dayOfWeek, fromMinutes, toMinutes } from '../../utils/time/cairo';

/** Bookable start times are offered every 30 minutes. */
export const SLOT_STEP_MINUTES = 30;
/** Earliest bookable start: 60 minutes from now (the provider needs time to get there). */
export const MIN_LEAD_MINUTES = 60;
/** How far ahead patients can book. */
export const BOOKING_HORIZON_DAYS = 60;

export type Interval = { start: Date; end: Date };
export type Slot = Interval & { available: boolean };

const MINUTE = 60_000;

/** Visit length: the service's default for per-visit, 60 min × hours, or 24 h × days. */
export const durationMinutes = (
  pricingUnit: PricingUnit,
  defaultDurationMinutes: number,
  quantity: number,
) => {
  if (pricingUnit === PricingUnit.PER_HOUR) return 60 * quantity;
  if (pricingUnit === PricingUnit.PER_DAY) return 24 * 60 * quantity;
  return defaultDurationMinutes;
};

export const overlaps = (a: Interval, b: Interval) => a.start < b.end && b.start < a.end;

/**
 * Bookable slots for one Cairo calendar date (spec §6.1, §7.7). Pure: weekly hours − busy intervals.
 *
 * - per-visit / per-hour: a start every 30 min such that the visit ends inside the working window.
 * - per-day: one slot per working window, starting at the window's start (the stay runs past the window).
 * - Starts sooner than MIN_LEAD_MINUTES from `now` are left out; slots clashing with `busy` are `available: false`.
 */
export const slotsForDay = (input: {
  availability: IAvailabilitySlot[];
  date: string;
  pricingUnit: PricingUnit;
  defaultDurationMinutes: number;
  quantity: number;
  busy: Interval[];
  now: Date;
}): Slot[] => {
  const duration = durationMinutes(input.pricingUnit, input.defaultDurationMinutes, input.quantity);
  const earliest = input.now.getTime() + MIN_LEAD_MINUTES * MINUTE;
  const weekday = dayOfWeek(input.date);
  const starts = new Set<number>();

  for (const window of input.availability.filter((w) => w.dayOfWeek === weekday)) {
    const from = toMinutes(window.startTime);
    const to = toMinutes(window.endTime);
    if (input.pricingUnit === PricingUnit.PER_DAY) {
      starts.add(from);
      continue;
    }
    for (let m = from; m + duration <= to; m += SLOT_STEP_MINUTES) starts.add(m);
  }

  return [...starts]
    .sort((a, b) => a - b)
    .map((m) => {
      const start = cairoToUtc(input.date, fromMinutes(m));
      return { start, end: new Date(start.getTime() + duration * MINUTE) };
    })
    .filter((slot) => slot.start.getTime() >= earliest)
    .map((slot) => ({ ...slot, available: !input.busy.some((b) => overlaps(slot, b)) }));
};
