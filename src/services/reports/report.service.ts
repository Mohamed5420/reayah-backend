import { Container, Service } from 'typedi';
import { BookingModel } from '../../database/models/booking/booking.model';
import { PaymentModel } from '../../database/models/payment/payment.models';
import { PayoutModel } from '../../database/models/payout/payout.models';
import { addDays, cairoToUtc } from '../../utils/time/cairo';
import { AuditService, type AuditContext } from '../audit/audit.service';

export const REPORT_TYPES = ['bookings', 'payments', 'payouts'] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

/** Cap per export; narrow the date range for more. */
export const REPORT_MAX_ROWS = 50_000;

/**
 * A spreadsheet cell: quoted, and a leading = + - @ (or tab / CR) is neutralised so a value can't run as
 * a formula when the file is opened in Excel (CSV injection).
 */
export const csvCell = (value: unknown) => {
  let text =
    value === null || value === undefined ? '' : value instanceof Date ? value.toISOString() : String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`; // numbers are safe
  return `"${text.replace(/"/g, '""')}"`;
};

const toCsv = (header: string[], rows: unknown[][]) =>
  // BOM so Excel opens Arabic text as UTF-8.
  `\uFEFF${[header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;

/**
 * GET /admin/reports/export (spec §7.15 finance). Money is in piastres; times are UTC. No personal or
 * medical data beyond ids and reference codes — names, phones and notes stay out of exports.
 */
@Service()
export class ReportService {
  private readonly audit = Container.get(AuditService);

  async export(type: ReportType, from: string, to: string, context: AuditContext) {
    const range = { $gte: cairoToUtc(from, '00:00'), $lt: cairoToUtc(addDays(to, 1), '00:00') };
    let csv: string;
    let rows: number;
    if (type === 'bookings') {
      const data = await BookingModel.find({ createdAt: range })
        .sort({ createdAt: 1 })
        .limit(REPORT_MAX_ROWS)
        .lean();
      rows = data.length;
      csv = toCsv(
        [
          'reference_code',
          'created_at',
          'scheduled_start',
          'status',
          'service',
          'area',
          'payment_method',
          'payment_status',
          'subtotal',
          'travel_fee',
          'discount',
          'total',
          'commission',
          'provider_payout',
          'provider_profile_id',
        ],
        data.map((b) => [
          b.referenceCode,
          b.createdAt,
          b.scheduledStart,
          b.status,
          b.service.nameAr,
          b.address.areaNameAr,
          b.paymentMethod,
          b.paymentStatus,
          b.price.subtotal,
          b.price.travelFee,
          b.price.discount,
          b.price.total,
          b.price.commissionAmount,
          b.price.providerPayout,
          b.providerProfileId,
        ]),
      );
    } else if (type === 'payments') {
      const data = await PaymentModel.find({ createdAt: range })
        .sort({ createdAt: 1 })
        .limit(REPORT_MAX_ROWS)
        .lean();
      rows = data.length;
      csv = toCsv(
        [
          'payment_id',
          'created_at',
          'booking_id',
          'method',
          'gateway',
          'status',
          'amount',
          'refunded_amount',
          'paid_at',
          'gateway_transaction_id',
        ],
        data.map((p) => [
          p._id,
          p.createdAt,
          p.bookingId,
          p.method,
          p.gateway,
          p.status,
          p.amount,
          p.refundedAmount,
          p.paidAt,
          p.gatewayTransactionId,
        ]),
      );
    } else {
      const data = await PayoutModel.find({ createdAt: range })
        .sort({ createdAt: 1 })
        .limit(REPORT_MAX_ROWS)
        .lean();
      rows = data.length;
      csv = toCsv(
        [
          'payout_id',
          'batch_date',
          'provider_profile_id',
          'amount',
          'status',
          'destination',
          'reference',
          'paid_at',
        ],
        data.map((p) => [
          p._id,
          p.batchDate,
          p.ownerId,
          p.amount,
          p.status,
          p.destinationLabel,
          p.reference,
          p.paidAt,
        ]),
      );
    }
    await this.audit.log(context, {
      action: 'report.export',
      entityType: 'report',
      entityId: type,
      metadata: { from, to, rows },
    });
    return { csv, filename: `reaya-${type}-${from}-to-${to}.csv` };
  }
}
