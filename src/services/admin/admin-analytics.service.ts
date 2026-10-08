import { Service } from 'typedi';
import type { PipelineStage } from 'mongoose';
import { BookingModel } from '../../database/models/booking/booking.model';
import { UserModel } from '../../database/models/user/user.model';
import { OrganizationModel } from '../../database/models/organization/organization.models';
import { UserRole } from '../../interfaces/enums';
import { BookingStatus } from '../../interfaces/IBooking';
import { BadRequestError } from '../../utils/types-errors';
import { addDays, cairoToUtc, CAIRO_TZ, dayOfWeek } from '../../utils/time/cairo';

export const ANALYTICS_METRICS = [
  'bookings',
  'completed_visits',
  'gmv',
  'revenue',
  'cancellation_rate',
  'active_providers',
  'new_patients',
  'new_providers',
  'new_organizations',
] as const;
export type AnalyticsMetric = (typeof ANALYTICS_METRICS)[number];
export const ANALYTICS_GROUPS = ['day', 'week', 'month'] as const;
export type AnalyticsGroup = (typeof ANALYTICS_GROUPS)[number];

/** Longest range per grouping, in days — keeps a chart readable and the aggregation cheap. */
const MAX_RANGE_DAYS: Record<AnalyticsGroup, number> = { day: 92, week: 366, month: 3 * 366 };

/** Weeks start on Saturday (the Egyptian calendar week). */
const WEEK_START_DOW = 6;

/**
 * Admin time series (spec §7.15 `/admin/analytics`; M3.5). Buckets are Cairo calendar days / weeks /
 * months, keyed by their first day ("YYYY-MM-DD"), zero-filled. Money is piastres.
 * - bookings, cancellation_rate: by creation time (rate = cancelled ÷ bookings, %, unpaid card bookings
 *   left out); completed_visits, gmv (`price.total`), revenue (commission), active_providers (distinct
 *   providers with a completed visit): by completion time; new_*: by sign-up time.
 * Aggregates only — no personal data leaves this service.
 */
@Service()
export class AdminAnalyticsService {
  async series(input: { metric: AnalyticsMetric; from: string; to: string; groupBy: AnalyticsGroup }) {
    const { metric, from, to, groupBy } = input;
    if (to < from) throw new BadRequestError('errors.analytics_range');
    const days = Math.round((Date.parse(to) - Date.parse(from)) / 864e5) + 1;
    if (days > MAX_RANGE_DAYS[groupBy]) {
      throw new BadRequestError('errors.analytics_range_too_long', { days: MAX_RANGE_DAYS[groupBy] });
    }
    const range = { $gte: cairoToUtc(from, '00:00'), $lt: cairoToUtc(addDays(to, 1), '00:00') };
    const rows = await this.aggregate(metric, range, groupBy);
    const byPeriod = new Map(rows.map((r) => [r._id, r]));
    const series = this.buckets(from, to, groupBy).map((period) => ({
      period,
      value: this.value(metric, byPeriod.get(period)),
    }));
    return { metric, groupBy, from, to, total: await this.total(metric, range, rows), series };
  }

  private aggregate(metric: AnalyticsMetric, range: { $gte: Date; $lt: Date }, groupBy: AnalyticsGroup) {
    const bucket = (field: string) => ({
      $dateToString: {
        format: '%Y-%m-%d',
        timezone: CAIRO_TZ,
        date: {
          $dateTrunc: { date: `$${field}`, unit: groupBy, timezone: CAIRO_TZ, startOfWeek: 'saturday' },
        },
      },
    });
    const completed = { status: BookingStatus.COMPLETED, completedAt: range };
    const run = (model: 'booking' | 'user' | 'org', pipeline: PipelineStage[]) =>
      model === 'booking'
        ? BookingModel.aggregate<Row>(pipeline)
        : model === 'user'
          ? UserModel.aggregate<Row>(pipeline)
          : OrganizationModel.aggregate<Row>(pipeline);

    switch (metric) {
      case 'bookings':
        return run('booking', [
          { $match: { createdAt: range } },
          { $group: { _id: bucket('createdAt'), value: { $sum: 1 } } },
        ]);
      case 'cancellation_rate':
        return run('booking', [
          { $match: { createdAt: range, status: { $ne: BookingStatus.AWAITING_PAYMENT } } },
          {
            $group: {
              _id: bucket('createdAt'),
              count: { $sum: 1 },
              cancelled: { $sum: { $cond: [{ $eq: ['$status', BookingStatus.CANCELLED] }, 1, 0] } },
            },
          },
        ]);
      case 'completed_visits':
      case 'gmv':
      case 'revenue': {
        const sum = { completed_visits: 1, gmv: '$price.total', revenue: '$price.commissionAmount' }[metric];
        return run('booking', [
          { $match: completed },
          { $group: { _id: bucket('completedAt'), value: { $sum: sum } } },
        ]);
      }
      case 'active_providers':
        return run('booking', [
          { $match: completed },
          { $group: { _id: bucket('completedAt'), providers: { $addToSet: '$providerProfileId' } } },
          { $project: { value: { $size: '$providers' }, providers: 1 } },
        ]);
      case 'new_patients':
      case 'new_providers':
        return run('user', [
          {
            $match: {
              createdAt: range,
              deletedAt: null,
              role: metric === 'new_patients' ? UserRole.PATIENT : UserRole.PROVIDER,
            },
          },
          { $group: { _id: bucket('createdAt'), value: { $sum: 1 } } },
        ]);
      case 'new_organizations':
        return run('org', [
          { $match: { createdAt: range, deletedAt: null } },
          { $group: { _id: bucket('createdAt'), value: { $sum: 1 } } },
        ]);
    }
  }

  private value(metric: AnalyticsMetric, row: Row | undefined) {
    if (metric === 'cancellation_rate') return rate(row?.cancelled ?? 0, row?.count ?? 0);
    return row?.value ?? 0;
  }

  private async total(metric: AnalyticsMetric, range: { $gte: Date; $lt: Date }, rows: Row[]) {
    if (metric === 'cancellation_rate') {
      const sum = (key: 'cancelled' | 'count') => rows.reduce((total, r) => total + (r[key] ?? 0), 0);
      return rate(sum('cancelled'), sum('count'));
    }
    // A provider active in two weeks counts once over the whole range.
    if (metric === 'active_providers') {
      return (
        await BookingModel.distinct('providerProfileId', {
          status: BookingStatus.COMPLETED,
          completedAt: range,
        })
      ).length;
    }
    return rows.reduce((total, r) => total + (r.value ?? 0), 0);
  }

  /** Every bucket's first day from `from` to `to`, so empty periods show as 0. */
  private buckets(from: string, to: string, groupBy: AnalyticsGroup) {
    const startOf = (date: string) =>
      groupBy === 'day'
        ? date
        : groupBy === 'week'
          ? addDays(date, -((dayOfWeek(date) - WEEK_START_DOW + 7) % 7))
          : `${date.slice(0, 8)}01`;
    const next = (date: string) => {
      if (groupBy === 'day') return addDays(date, 1);
      if (groupBy === 'week') return addDays(date, 7);
      const [y, m] = date.split('-').map(Number);
      return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
    };
    const out: string[] = [];
    for (let d = startOf(from); d <= to; d = next(d)) out.push(d);
    return out;
  }
}

type Row = { _id: string; value?: number; count?: number; cancelled?: number };

/** Percent with one decimal; 0 when there's nothing to divide by. */
const rate = (part: number, whole: number) => (whole ? Math.round((part / whole) * 1000) / 10 : 0);
