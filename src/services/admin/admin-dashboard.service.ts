import { Service } from 'typedi';
import { BookingModel } from '../../database/models/booking/booking.model';
import { ProviderProfileModel } from '../../database/models/provider/provider-profile.model';
import { ProviderDocumentModel } from '../../database/models/provider/provider-document.model';
import { DisputeModel } from '../../database/models/aftercare/aftercare.models';
import { AuditLogModel } from '../../database/models/audit-log/audit-log.model';
import { VerificationStatus } from '../../interfaces/enums';
import { BookingStatus } from '../../interfaces/IBooking';
import { DisputeStatus } from '../../interfaces/IAftercare';
import { addDays, cairoDate, cairoToUtc, CAIRO_TZ } from '../../utils/time/cairo';

/** Documents expiring within this many days need attention (spec §4.4). */
export const DOCUMENT_EXPIRY_WARNING_DAYS = 30;

/** Admin home (spec §7.15 "Dashboard"). Read-only aggregates; organizations and payments join in later phases. */
@Service()
export class AdminDashboardService {
  async dashboard() {
    const today = cairoDate();
    const todayStart = cairoToUtc(today, '00:00');
    const tomorrowStart = cairoToUtc(addDays(today, 1), '00:00');
    const chartStart = cairoToUtc(addDays(today, -13), '00:00');
    const monthStart = new Date(Date.now() - 30 * 24 * 3600_000);

    const [
      money,
      activeProviders,
      pendingVerifications,
      openDisputes,
      perDay,
      todayByStatus,
      topAreas,
      recent,
    ] = await Promise.all([
      BookingModel.aggregate<{ gmv: number; revenue: number; completed: number }>([
        { $match: { status: BookingStatus.COMPLETED, completedAt: { $gte: monthStart } } },
        {
          $group: {
            _id: null,
            gmv: { $sum: '$price.total' },
            revenue: { $sum: '$price.commissionAmount' },
            completed: { $sum: 1 },
          },
        },
      ]),
      ProviderProfileModel.countDocuments({
        verificationStatus: VerificationStatus.APPROVED,
        isAcceptingBookings: true,
      }),
      ProviderProfileModel.countDocuments({ verificationStatus: VerificationStatus.PENDING }),
      DisputeModel.countDocuments({ status: DisputeStatus.OPEN }),
      // Bookings created per Cairo day, last 14 days.
      BookingModel.aggregate<{ _id: string; count: number }>([
        { $match: { createdAt: { $gte: chartStart } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: CAIRO_TZ } },
            count: { $sum: 1 },
          },
        },
      ]),
      BookingModel.aggregate<{ _id: BookingStatus; count: number }>([
        { $match: { scheduledStart: { $gte: todayStart, $lt: tomorrowStart } } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      BookingModel.aggregate<{ _id: string; count: number }>([
        { $match: { createdAt: { $gte: monthStart } } },
        { $group: { _id: '$address.areaNameAr', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 5 },
      ]),
      AuditLogModel.find().sort({ createdAt: -1 }).limit(10).lean(),
    ]);

    const counts = new Map(perDay.map((d) => [d._id, d.count]));
    return {
      kpis: {
        bookingsToday: todayByStatus.reduce((sum, s) => sum + s.count, 0),
        gmv30d: money[0]?.gmv ?? 0,
        revenue30d: money[0]?.revenue ?? 0,
        completed30d: money[0]?.completed ?? 0,
        activeProviders,
        pendingVerifications,
        openDisputes,
      },
      bookings14d: Array.from({ length: 14 }, (_, i) => {
        const date = addDays(today, i - 13);
        return { date, count: counts.get(date) ?? 0 };
      }),
      todayByStatus: Object.fromEntries(todayByStatus.map((s) => [s._id, s.count])),
      topAreas: topAreas.map((a) => ({ areaName: a._id, bookings: a.count })),
      recentActivity: recent,
    };
  }

  /**
   * "Needs attention" (spec §7.15): requests nobody took in the last 24 h, open disputes, documents
   * expiring within 30 days or already expired. Organizations past their deadline and failed payments
   * join in Phase 2/3.
   */
  async attention() {
    const now = new Date();
    const [expiredRequests, openDisputes, expiringDocuments] = await Promise.all([
      BookingModel.find({
        status: BookingStatus.EXPIRED,
        updatedAt: { $gte: new Date(now.getTime() - 24 * 3600_000) },
      })
        .sort({ updatedAt: -1 })
        .limit(50)
        .lean(),
      DisputeModel.find({ status: DisputeStatus.OPEN }).sort({ createdAt: 1 }).limit(50).lean(),
      ProviderDocumentModel.find({
        expiresAt: {
          $ne: null,
          $lte: new Date(now.getTime() + DOCUMENT_EXPIRY_WARNING_DAYS * 24 * 3600_000),
        },
      })
        .sort({ expiresAt: 1 })
        .limit(100)
        .lean(),
    ]);
    return { expiredRequests, openDisputes, expiringDocuments, now };
  }
}
