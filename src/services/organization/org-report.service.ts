import { Container, Service } from 'typedi';
import { Types } from 'mongoose';
import { BookingModel } from '../../database/models/booking/booking.model';
import { BookingOfferModel } from '../../database/models/booking/booking-offer.model';
import { ReviewModel } from '../../database/models/aftercare/aftercare.models';
import { ProviderProfileModel } from '../../database/models/provider/provider-profile.model';
import { UserModel } from '../../database/models/user/user.model';
import { VerificationStatus } from '../../interfaces/enums';
import { AssignmentMode, BookingStatus, OfferStatus, type IBooking } from '../../interfaces/IBooking';
import { LedgerOwnerType } from '../../interfaces/ILedger';
import type { IOrganization } from '../../interfaces/IOrganization';
import { t, type Language } from '../../utils/i18n';
import { addDays, cairoDate, cairoToUtc } from '../../utils/time/cairo';
import { CommissionService } from '../payouts/commission.service';

export type DashboardPeriod = 'today' | 'week' | 'month';
/** `branch`: by clinic branch (C4); home visits are one row of their own. */
export type ReportGroup = 'day' | 'staff' | 'service' | 'branch';

const ENDED = [
  BookingStatus.COMPLETED,
  BookingStatus.DISPUTED,
  BookingStatus.CANCELLED,
  BookingStatus.NO_SHOW,
];
const DONE = [BookingStatus.COMPLETED, BookingStatus.DISPUTED];
const ACTIVE_VISIT = [BookingStatus.ACCEPTED, BookingStatus.ON_THE_WAY, BookingStatus.IN_PROGRESS];

const ratio = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) / 100 : null);

/**
 * The owner's dashboard and reports (spec §7.11 `/org/dashboard`, `/org/reports`; M3.4). Built from the
 * organization's bookings — gross is what patients paid for completed visits (service + travel fee),
 * commission the platform's share, net what the organization earns.
 */
@Service()
export class OrgReportService {
  /** GET /org/dashboard?period=today|week|month (Cairo days). */
  async dashboard(org: IOrganization, period: DashboardPeriod, lang: Language, now = new Date()) {
    const today = cairoDate(now);
    const fromDate =
      period === 'today' ? today : period === 'week' ? addDays(today, -6) : `${today.slice(0, 8)}01`;
    const range = { $gte: cairoToUtc(fromDate, '00:00'), $lt: cairoToUtc(addDays(today, 1), '00:00') };
    const [bookings, staff, offers, overLimit] = await Promise.all([
      BookingModel.find({
        organizationId: org._id,
        status: { $ne: BookingStatus.AWAITING_PAYMENT },
        scheduledStart: range,
      })
        .select('status providerProfileId assignmentMode price createdAt')
        .lean(),
      ProviderProfileModel.find({ organizationId: org._id, verificationStatus: VerificationStatus.APPROVED })
        .select('userId isAcceptingBookings staffSuspended ratingAvg ratingCount')
        .lean(),
      BookingOfferModel.countDocuments({
        organizationId: org._id,
        providerProfileId: null,
        status: OfferStatus.OFFERED,
        expiresAt: { $gt: now },
      }),
      Container.get(CommissionService).overLimit(org._id, LedgerOwnerType.ORGANIZATION),
    ]);
    const online = new Set(
      (
        await UserModel.find({ _id: { $in: staff.map((s) => s.userId) }, isOnline: true })
          .select('_id')
          .lean()
      ).map((u) => String(u._id)),
    );
    // The queue: waiting for the owner now, whatever day the visit is.
    const unassigned = await BookingModel.find({
      organizationId: org._id,
      status: BookingStatus.PENDING,
      providerProfileId: null,
      assignmentMode: AssignmentMode.ORGANIZATION,
    })
      .select('createdAt')
      .sort({ createdAt: 1 })
      .lean();
    const done = bookings.filter((b) => DONE.includes(b.status));
    const ratingCount = staff.reduce((total, s) => total + s.ratingCount, 0);
    const alerts = [
      ...unassigned.map((b) => ({
        type: 'unassigned_booking' as const,
        booking_id: String(b._id),
        message: t(
          'org.alert_unassigned',
          { minutes: Math.max(0, Math.floor((now.getTime() - b.createdAt.getTime()) / 60_000)) },
          lang,
        ),
      })),
      ...(offers
        ? [
            {
              type: 'offers_available' as const,
              booking_id: null,
              message: t('org.alert_offers', { count: offers }, lang),
            },
          ]
        : []),
      ...(overLimit
        ? [
            {
              type: 'commission_limit' as const,
              booking_id: null,
              message: t('org.alert_commission_limit', {}, lang),
            },
          ]
        : []),
    ];
    return {
      period,
      bookings: {
        total: bookings.length,
        pending: bookings.filter((b) => b.status === BookingStatus.PENDING).length,
        unassigned: unassigned.length,
        in_progress: bookings.filter((b) => ACTIVE_VISIT.includes(b.status)).length,
        completed: done.length,
        cancelled: bookings.filter((b) => b.status === BookingStatus.CANCELLED).length,
      },
      staff: {
        total: staff.length,
        active_now: staff.filter(
          (s) => s.isAcceptingBookings && !s.staffSuspended && online.has(String(s.userId)),
        ).length,
      },
      revenue: {
        gross: done.reduce((total, b) => total + b.price.subtotal + b.price.travelFee, 0),
        commission: done.reduce((total, b) => total + b.price.commissionAmount, 0),
        net: done.reduce((total, b) => total + b.price.providerPayout, 0),
      },
      rating_avg: ratingCount
        ? Math.round(
            (staff.reduce((total, s) => total + s.ratingAvg * s.ratingCount, 0) / ratingCount) * 10,
          ) / 10
        : 0,
      alerts,
    };
  }

  /** GET /org/reports?from&to&group_by — visits by scheduled Cairo date in [from, to]. */
  async report(
    org: IOrganization,
    input: { from: string; to: string; groupBy: ReportGroup },
    lang: Language,
  ) {
    const bookings = await BookingModel.find({
      organizationId: org._id,
      status: { $in: ENDED },
      scheduledStart: {
        $gte: cairoToUtc(input.from, '00:00'),
        $lt: cairoToUtc(addDays(input.to, 1), '00:00'),
      },
    })
      .select('status providerProfileId serviceId service scheduledStart price isOnTime clinicId clinic')
      .lean();
    const reviews = await ReviewModel.find({
      bookingId: { $in: bookings.map((b) => b._id) },
      isVisible: true,
    })
      .select('bookingId rating')
      .lean();
    const ratingOf = new Map(reviews.map((r) => [String(r.bookingId), r.rating]));
    const names = await this.staffNames(bookings);

    const keyOf = (b: IBooking): [string, string] =>
      input.groupBy === 'day'
        ? [cairoDate(b.scheduledStart), cairoDate(b.scheduledStart)]
        : input.groupBy === 'branch'
          ? b.clinicId
            ? [String(b.clinicId), b.clinic?.name ?? '']
            : ['home_visit', t('reports.home_visits', undefined, lang)]
          : input.groupBy === 'staff'
            ? [String(b.providerProfileId), names.get(String(b.providerProfileId)) ?? '']
            : [String(b.serviceId), (lang === 'en' && b.service.nameEn) || b.service.nameAr];
    const groups = new Map<string, { label: string; bookings: IBooking[] }>();
    for (const b of bookings as IBooking[]) {
      if (input.groupBy === 'staff' && !b.providerProfileId) continue;
      const [key, label] = keyOf(b);
      const group = groups.get(key) ?? { label, bookings: [] };
      group.bookings.push(b);
      groups.set(key, group);
    }
    const summarize = (list: IBooking[]) => {
      const done = list.filter((b) => DONE.includes(b.status));
      const rated = done.flatMap((b) => (ratingOf.has(String(b._id)) ? [ratingOf.get(String(b._id))!] : []));
      const timed = done.filter((b) => b.isOnTime !== null);
      return {
        visits: done.length,
        revenue: done.reduce((total, b) => total + b.price.subtotal + b.price.travelFee, 0),
        rating: rated.length ? Math.round((rated.reduce((a, r) => a + r, 0) / rated.length) * 10) / 10 : null,
        on_time_rate: ratio(timed.filter((b) => b.isOnTime).length, timed.length),
        cancellation_rate: ratio(
          list.filter((b) => b.status === BookingStatus.CANCELLED).length,
          list.length,
        ),
      };
    };
    const summary = summarize(bookings as IBooking[]);
    return {
      period: { from: input.from, to: input.to },
      summary: {
        visits: summary.visits,
        revenue: summary.revenue,
        avg_rating: summary.rating,
        cancellation_rate: summary.cancellation_rate,
        on_time_rate: summary.on_time_rate,
      },
      rows: [...groups.entries()]
        .map(([key, g]) => {
          const s = summarize(g.bookings);
          return {
            key,
            label: g.label,
            visits: s.visits,
            revenue: s.revenue,
            rating: s.rating,
            on_time_rate: s.on_time_rate,
          };
        })
        .sort((a, b) => (input.groupBy === 'day' ? a.key.localeCompare(b.key) : b.visits - a.visits)),
    };
  }

  private async staffNames(bookings: Array<Pick<IBooking, 'providerProfileId'>>) {
    const ids = [
      ...new Set(bookings.flatMap((b) => (b.providerProfileId ? [String(b.providerProfileId)] : []))),
    ];
    const profiles = await ProviderProfileModel.find({
      _id: { $in: ids.map((id) => new Types.ObjectId(id)) },
    })
      .select('userId')
      .setOptions({ withDeleted: true })
      .lean();
    const users = new Map(
      (
        await UserModel.find({ _id: { $in: profiles.map((p) => p.userId) } })
          .select('fullName')
          .setOptions({ withDeleted: true })
          .lean()
      ).map((u) => [String(u._id), u.fullName]),
    );
    return new Map(profiles.map((p) => [String(p._id), users.get(String(p.userId)) ?? '']));
  }
}
