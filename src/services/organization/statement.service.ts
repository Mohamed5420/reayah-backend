import { Container, Service } from 'typedi';
import { Types } from 'mongoose';
import { BookingModel } from '../../database/models/booking/booking.model';
import { WalletLedgerModel } from '../../database/models/ledger/wallet.model';
import {
  OrganizationModel,
  OrgStatementModel,
  PlanChargeModel,
} from '../../database/models/organization/organization.models';
import { BookingStatus } from '../../interfaces/IBooking';
import { LedgerEntryType, LedgerOwnerType } from '../../interfaces/ILedger';
import { logger } from '../../utils/logger/winston';
import type { Pagination } from '../../utils/response/pagination';
import { cairoDate, cairoToUtc } from '../../utils/time/cairo';
import { NotFoundError } from '../../utils/types-errors';
import { StorageService } from '../storage/storage.service';
import { renderStatementPdf } from './statement-pdf';

/** [start, end) of a Cairo month "YYYY-MM". */
export const monthRange = (period: string) => {
  const [year, month] = period.split('-').map(Number);
  const next = month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`;
  return { from: cairoToUtc(`${period}-01`, '00:00'), to: cairoToUtc(`${next}-01`, '00:00') };
};

/** The Cairo month before the one `now` falls in. */
export const previousMonth = (now = new Date()) => {
  const [year, month] = cairoDate(now).split('-').map(Number);
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`;
};

/**
 * Monthly statements for organizations (spec §7.11 `/org/invoices`; decision M3.4): the platform's
 * commission on the month's completed visits (cash and card) and plan fees, as an Arabic PDF in private
 * storage. Generated once per organization and month (unique index) by a daily job.
 */
@Service()
export class StatementService {
  private readonly storage = Container.get(StorageService);

  /** Daily: last month's statements (a no-op once they exist). */
  runDaily(now = new Date()) {
    return this.generate(previousMonth(now));
  }

  async generate(period: string) {
    const { from, to } = monthRange(period);
    const [bookingOrgs, ledgerOrgs] = await Promise.all([
      BookingModel.distinct('organizationId', {
        organizationId: { $ne: null },
        status: { $in: [BookingStatus.COMPLETED, BookingStatus.DISPUTED] },
        completedAt: { $gte: from, $lt: to },
      }),
      PlanChargeModel.distinct('organizationId', {
        $or: [{ chargedAt: { $gte: from, $lt: to } }, { creditedAt: { $gte: from, $lt: to } }],
      }),
    ]);
    const orgIds = [...new Set([...bookingOrgs, ...ledgerOrgs].map(String))];
    let created = 0;
    for (const orgId of orgIds) {
      try {
        if (await this.generateFor(new Types.ObjectId(orgId), period)) created++;
      } catch (err) {
        logger.error(`Statement ${period} failed for organization ${orgId}`, err);
      }
    }
    return created;
  }

  /** One organization's statement for a month; null if it exists already or there's nothing to bill. */
  async generateFor(organizationId: Types.ObjectId, period: string) {
    if (await OrgStatementModel.exists({ organizationId, period })) return null;
    const org = await OrganizationModel.findById(organizationId).setOptions({ withDeleted: true }).lean();
    if (!org) return null;
    const { from, to } = monthRange(period);
    const [bookings, charges, ledgerCredits] = await Promise.all([
      BookingModel.aggregate<{ visits: number; commission: number }>([
        {
          $match: {
            organizationId,
            status: { $in: [BookingStatus.COMPLETED, BookingStatus.DISPUTED] },
            completedAt: { $gte: from, $lt: to },
          },
        },
        { $group: { _id: null, visits: { $sum: 1 }, commission: { $sum: '$price.commissionAmount' } } },
      ]),
      PlanChargeModel.find({
        organizationId,
        $or: [{ chargedAt: { $gte: from, $lt: to } }, { creditedAt: { $gte: from, $lt: to } }],
      }).lean(),
      WalletLedgerModel.aggregate<{ total: number }>([
        {
          $match: {
            ownerType: LedgerOwnerType.ORGANIZATION,
            ownerId: organizationId,
            type: LedgerEntryType.SUBSCRIPTION_CREDIT,
            createdAt: { $gte: from, $lt: to },
          },
        },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
    ]);
    const inMonth = (d: Date | null) => !!d && d >= from && d < to;
    const visits = bookings[0]?.visits ?? 0;
    const commission = bookings[0]?.commission ?? 0;
    const subscriptionFees = charges.filter((c) => inMonth(c.chargedAt)).reduce((t, c) => t + c.amount, 0);
    const subscriptionCredits =
      charges.filter((c) => inMonth(c.creditedAt)).reduce((t, c) => t + c.credited, 0) +
      (ledgerCredits[0]?.total ?? 0);
    if (!visits && !subscriptionFees && !subscriptionCredits) return null;

    const statement = await OrgStatementModel.create({
      organizationId,
      period,
      number: `RY-ST-${period.replace('-', '')}-${String(organizationId).slice(-6).toUpperCase()}`,
      visits,
      commission,
      subscriptionFees,
      subscriptionCredits,
      total: commission + subscriptionFees - subscriptionCredits,
    });
    const pdf = await renderStatementPdf(statement.toObject(), org);
    statement.pdfKey = await this.storage.put(
      `org-statements/${String(organizationId)}`,
      pdf,
      'application/pdf',
    );
    await statement.save();
    return statement.toObject();
  }

  async list(organizationId: Types.ObjectId, pagination: Pagination) {
    const query = { organizationId };
    const [data, total] = await Promise.all([
      OrgStatementModel.find(query)
        .sort({ period: -1 })
        .skip(pagination.skip)
        .limit(pagination.perPage)
        .lean(),
      OrgStatementModel.countDocuments(query),
    ]);
    return { data, total };
  }

  /** GET /org/invoices/{id}/pdf — a signed link (10 minutes). */
  async pdfUrl(organizationId: Types.ObjectId, statementId: string) {
    const statement = Types.ObjectId.isValid(statementId)
      ? await OrgStatementModel.findOne({ _id: statementId, organizationId }).lean()
      : null;
    if (!statement?.pdfKey) throw new NotFoundError('errors.statement_not_found');
    return { url: await this.storage.signedUrl(statement.pdfKey), statement };
  }
}
