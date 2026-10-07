/**
 * Africa/Cairo wall-clock ↔ UTC (spec §10: store UTC, schedule in Cairo time). Egypt observes DST again
 * since 2023 (UTC+2 winter, UTC+3 summer), so offsets come from the runtime's tz database, never a constant.
 */
export const CAIRO_TZ = 'Africa/Cairo';

const formatter = new Intl.DateTimeFormat('en-US', {
  timeZone: CAIRO_TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

const cairoParts = (instant: Date) => {
  const parts = Object.fromEntries(formatter.formatToParts(instant).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
};

/** Cairo's offset from UTC at that instant, in minutes (120 or 180). */
export const cairoOffsetMinutes = (instant: Date): number => {
  const p = cairoParts(instant);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - instant.getTime()) / 60_000);
};

/** "YYYY-MM-DD" + "HH:mm" in Cairo → the UTC instant. */
export const cairoToUtc = (date: string, time: string): Date => {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const wallAsUtc = Date.UTC(y, m - 1, d, hh, mm);
  // Two passes: the offset can differ between the guess and the result around DST switches.
  const guess = wallAsUtc - cairoOffsetMinutes(new Date(wallAsUtc)) * 60_000;
  return new Date(wallAsUtc - cairoOffsetMinutes(new Date(guess)) * 60_000);
};

/** The Cairo calendar date of an instant, "YYYY-MM-DD". */
export const cairoDate = (instant: Date = new Date()): string => {
  const p = cairoParts(instant);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
};

/** 0 = Sunday … 6 = Saturday, for a calendar date (the weekday doesn't depend on the time zone). */
export const dayOfWeek = (date: string): number => new Date(`${date}T12:00:00Z`).getUTCDay();

/** Calendar arithmetic on "YYYY-MM-DD". */
export const addDays = (date: string, days: number): string => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** "HH:mm" → minutes after midnight, and back. */
export const toMinutes = (time: string) => {
  const [hh, mm] = time.split(':').map(Number);
  return hh * 60 + mm;
};
export const fromMinutes = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** "الأحد ٤ أكتوبر، ١٠:٠٠ ص" — a visit time in Cairo, for notification text. */
export const formatCairoDateTime = (instant: Date, lang: 'ar' | 'en' = 'ar') =>
  new Intl.DateTimeFormat(lang === 'ar' ? 'ar-EG' : 'en-GB', {
    timeZone: CAIRO_TZ,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: 'numeric',
    minute: '2-digit',
  }).format(instant);
