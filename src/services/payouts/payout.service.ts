import { Container, Service } from 'typedi';
import { Types, type ClientSession } from 'mongoose';
import { withTransaction } from '../../database/transaction';
import { BookingModel } from '../../database/models/booking/booking.model';
import { WalletBalanceModel, WalletLedgerModel } from '../../database/models/ledger/wallet.model';
import { PayoutMethodModel, PayoutModel } from '../../database/models/payout/payout.models';
import { ProviderProfileModel } from '../../database/models/provider/provider-profile.model';
import { OrganizationModel } from '../../database/models/organization/organization.models';
import { SubscriptionService } from '../organization/subscription.service';
import { UserModel } from '../../database/models/user/user.model';
import { getRedis } from '../../config/redis.config';
import { BookingStatus, PaymentMethod } from '../../interfaces/IBooking';
import { LedgerEntryType, LedgerOwnerType } from '../../interfaces/ILedger';
import { NotificationType } from '../../interfaces/INotification';
import {
  PayoutMethodType,
  PayoutStatus,
  type IPayout,
  type IPayoutMethod,
  type WalletProvider,
} from '../../interfaces/IPayout';
import { decryptNullable } from '../../utils/crypto/field-encryption';
import type { Pagination } from '../../utils/response/pagination';
import { addDays, cairoDate, cairoToUtc, CAIRO_TZ, dayOfWeek } from '../../utils/time/cairo';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/types-errors';
import { AuditService, SYSTEM_AUDIT_CONTEXT, type AuditContext } from '../audit/audit.service';
import { LedgerService } from '../ledger/ledger.service';
import { NotificationService } from '../notification/notification.service';
import { SettingsService } from '../settings/settings.service';
import { WEEKDAYS } from '../settings/settings.definitions';

/** Why a balance isn't paid in the next batch (codes the app maps to its own text). */
export type NextPayoutReason = 'below_minimum' | 'no_payout_method' | 'payout_in_progress' | 'commission_due';

const PROVIDER = LedgerOwnerType.PROVIDER;
const ORGANIZATION = LedgerOwnerType.ORGANIZATION;

/** Whose money: a provider profile (independent) or an organization. A bare id means a provider. */
export type EarningsOwner = { ownerType: LedgerOwnerType; ownerId: Types.ObjectId };
const asOwner = (owner: Types.ObjectId | EarningsOwner): EarningsOwner =>
  owner instanceof Types.ObjectId ? { ownerType: PROVIDER, ownerId: owner } : owner;

export type PayoutMethodInput = {
  type: PayoutMethodType;
  accountHolder: string;
  bankName?: string | null;
  walletProvider?: WalletProvider | null;
  accountNumber: string;
};

/** "بنك مصر •••• 4821" / "vodafone_cash •••• 5567": safe to show and log. */
export const maskedLabel = (
  m: Pick<IPayoutMethod, 'type' | 'bankName' | 'walletProvider' | 'accountNumber'>,
) =>
  `${m.type === PayoutMethodType.BANK ? (m.bankName ?? 'bank') : (m.walletProvider ?? 'wallet')} •••• ${m.accountNumber.slice(-4)}`;

/**
 * Provider earnings and payouts (spec §4.8, §7.10 earnings, §7.15 finance). Money moves only through
 * the append-only ledger: card bookings credit the provider's share, cash bookings debit the platform's
 * commission, and a payout takes the positive balance out the moment it's generated (a `payout` entry),
 * so later earnings start a new balance. A cancelled payout puts the money back (an `adjustment`).
 * Organizations get the same flow (owner type `organization`, M3.4); a bare id means a provider.
 */
@Service()
export class PayoutService {
  private readonly ledger = Container.get(LedgerService);
  private readonly settings = Container.get(SettingsService);
  private readonly audit = Container.get(AuditService);
  private readonly notifications = Container.get(NotificationService);

  // ── Provider ──

  async getMethod(of: Types.ObjectId | EarningsOwner) {
    const method = await PayoutMethodModel.findOne(asOwner(of));
    return method ? (method.toObject() as IPayoutMethod) : null;
  }

  async setMethod(of: Types.ObjectId | EarningsOwner, input: PayoutMethodInput) {
    const owner = asOwner(of);
    const fields =
      input.type === PayoutMethodType.BANK
        ? { bankName: input.bankName ?? null, walletProvider: null }
        : { bankName: null, walletProvider: input.walletProvider ?? null };
    if (input.type === PayoutMethodType.BANK && !fields.bankName) {
      throw new ValidationError({ bank_name: ['validation.required'] });
    }
    if (input.type === PayoutMethodType.WALLET && !fields.walletProvider) {
      throw new ValidationError({ wallet_provider: ['validation.required'] });
    }
    const method = (await PayoutMethodModel.findOne(owner)) ?? new PayoutMethodModel(owner);
    method.set({
      type: input.type,
      accountHolder: input.accountHolder,
      accountNumber: input.accountNumber,
      ...fields,
    });
    await method.save();
    return method.toObject() as IPayoutMethod;
  }

  /** GET /provider/earnings — completed visits in [from, to] (Cairo dates) + the current balance. */
  async earnings(of: Types.ObjectId | EarningsOwner, from: string, to: string) {
    const owner = asOwner(of);
    const [totals] = await BookingModel.aggregate<{
      visits: number;
      gross: number;
      commission: number;
      net: number;
    }>([
      {
        $match: {
          // An organization earns every visit its staff completed; a provider their own (not as staff).
          ...(owner.ownerType === ORGANIZATION
            ? { organizationId: owner.ownerId }
            : { providerProfileId: owner.ownerId, organizationId: null }),
          status: { $in: [BookingStatus.COMPLETED, BookingStatus.DISPUTED] },
          completedAt: { $gte: cairoToUtc(from, '00:00'), $lt: cairoToUtc(addDays(to, 1), '00:00') },
        },
      },
      {
        $group: {
          _id: null,
          visits: { $sum: 1 },
          gross: { $sum: { $add: ['$price.subtotal', '$price.travelFee'] } },
          commission: { $sum: '$price.commissionAmount' },
          net: { $sum: '$price.providerPayout' },
        },
      },
    ]);
    const balance = await this.balance(owner);
    return {
      from,
      to,
      completedVisits: totals?.visits ?? 0,
      gross: totals?.gross ?? 0,
      commission: totals?.commission ?? 0,
      net: totals?.net ?? 0,
      balance,
      walletBalance: Math.max(balance, 0),
      commissionDue: Math.max(-balance, 0),
    };
  }

  /**
   * The earnings chart: one row per Cairo day in [from, to], zeros included — visits completed that day
   * and their net (what the provider earns), plus the cash the provider took from patients in the period.
   */
  async dailyEarnings(of: Types.ObjectId | EarningsOwner, from: string, to: string) {
    const owner = asOwner(of);
    const rows = await BookingModel.aggregate<{ _id: string; visits: number; net: number; cash: number }>([
      {
        $match: {
          ...(owner.ownerType === ORGANIZATION
            ? { organizationId: owner.ownerId }
            : { providerProfileId: owner.ownerId, organizationId: null }),
          status: { $in: [BookingStatus.COMPLETED, BookingStatus.DISPUTED] },
          completedAt: { $gte: cairoToUtc(from, '00:00'), $lt: cairoToUtc(addDays(to, 1), '00:00') },
        },
      },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$completedAt', timezone: CAIRO_TZ } },
          visits: { $sum: 1 },
          net: { $sum: '$price.providerPayout' },
          cash: { $sum: { $cond: [{ $eq: ['$paymentMethod', PaymentMethod.CASH] }, '$price.total', 0] } },
        },
      },
    ]);
    const byDay = new Map(rows.map((r) => [r._id, r]));
    const days: Array<{ date: string; completedVisits: number; net: number }> = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const row = byDay.get(d);
      days.push({ date: d, completedVisits: row?.visits ?? 0, net: row?.net ?? 0 });
    }
    return { days, cashCollected: rows.reduce((sum, r) => sum + r.cash, 0) };
  }

  /**
   * The next weekly payout (`payout_day`, Cairo) and whether this balance will be paid in it. When not,
   * `reason` says why, as a code the app maps to its own text.
   */
  async nextPayout(of: Types.ObjectId | EarningsOwner, now = new Date()) {
    const owner = asOwner(of);
    const [day, minimum, balance, method, open] = await Promise.all([
      this.settings.get('payout_day'),
      this.settings.get('payout_min_amount'),
      this.balance(owner),
      PayoutMethodModel.exists(owner),
      PayoutModel.exists({ ...owner, status: { $in: [PayoutStatus.PENDING, PayoutStatus.APPROVED] } }),
    ]);
    const today = cairoDate(now);
    let date = today;
    while (WEEKDAYS[(dayOfWeek(date) + 1) % 7] !== day) date = addDays(date, 1);
    // Today's batch already ran → next week.
    if (date === today && (await getRedis().exists(`payout-batch:${today}`))) date = addDays(date, 7);
    const reason: NextPayoutReason | null = open
      ? 'payout_in_progress'
      : balance < 0
        ? 'commission_due'
        : !method
          ? 'no_payout_method'
          : balance < Math.max(1, minimum)
            ? 'below_minimum'
            : null;
    return { date, amount: Math.max(balance, 0), minimumAmount: minimum, eligible: !reason, reason };
  }

  async ledgerEntries(of: Types.ObjectId | EarningsOwner, pagination: Pagination) {
    const query = asOwner(of);
    const [data, total] = await Promise.all([
      WalletLedgerModel.find(query)
        .sort({ createdAt: -1, _id: -1 })
        .skip(pagination.skip)
        .limit(pagination.perPage)
        .lean(),
      WalletLedgerModel.countDocuments(query),
    ]);
    return { data, total };
  }

  async payoutsOf(of: Types.ObjectId | EarningsOwner, pagination: Pagination) {
    const query = asOwner(of);
    const [data, total] = await Promise.all([
      PayoutModel.find(query).sort({ createdAt: -1 }).skip(pagination.skip).limit(pagination.perPage).lean(),
      PayoutModel.countDocuments(query),
    ]);
    return { data, total };
  }

  // ── Batches ──

  /**
   * Daily job: on `payout_day` (Cairo), generates the week's batch once (Redis claim, so several
   * instances or a re-run don't make a second batch).
   */
  async runScheduled(now = new Date()) {
    const day = await this.settings.get('payout_day');
    const today = cairoDate(now);
    // WEEKDAYS starts on Saturday; dayOfWeek is 0 = Sunday.
    if (WEEKDAYS[(dayOfWeek(today) + 1) % 7] !== day) return { created: 0 };
    const claimed = await getRedis().set(`payout-batch:${today}`, '1', 'EX', 3 * 24 * 3600, 'NX');
    if (!claimed) return { created: 0 };
    const payouts = await this.generateBatch(SYSTEM_AUDIT_CONTEXT, now);
    return { created: payouts.length };
  }

  /**
   * One payout per provider whose balance reached `payout_min_amount` and who has a payout method,
   * skipping anyone with a payout still open. Each is created in a transaction with its ledger entry.
   */
  async generateBatch(context: AuditContext, now = new Date()) {
    const minimum = Math.max(1, await this.settings.get('payout_min_amount'));
    const batchDate = cairoDate(now);
    const candidates = await WalletBalanceModel.find({
      ownerType: { $in: [PROVIDER, ORGANIZATION] },
      balance: { $gte: minimum },
    }).lean();
    const created: IPayout[] = [];
    for (const wallet of candidates) {
      const owner = { ownerType: wallet.ownerType, ownerId: wallet.ownerId };
      const method = await PayoutMethodModel.findOne(owner);
      if (!method) continue;
      const open = await PayoutModel.exists({
        ...owner,
        status: { $in: [PayoutStatus.PENDING, PayoutStatus.APPROVED] },
      });
      if (open) continue;
      const plain = method.toObject() as IPayoutMethod;
      const payout = await withTransaction(async (session) => {
        // Re-read inside the transaction: the balance may have moved since the scan.
        // Organizations: unpaid plan fees come out of the earnings first (netting, decision M3.4).
        if (owner.ownerType === ORGANIZATION) {
          await Container.get(SubscriptionService).settle(session, owner.ownerId, now);
        }
        const current = await WalletBalanceModel.findOne(owner, null, { session }).lean();
        if (!current || current.balance < minimum) return null;
        const statement = await this.statementSinceLastPayout(owner, current.balance, session);
        const [doc] = await PayoutModel.create(
          [
            {
              ...owner,
              amount: current.balance,
              destination: JSON.stringify({
                type: plain.type,
                accountHolder: plain.accountHolder,
                bankName: plain.bankName,
                walletProvider: plain.walletProvider,
                accountNumber: plain.accountNumber,
              }),
              destinationLabel: maskedLabel(plain),
              statement,
              batchDate,
            },
          ],
          { session },
        );
        await this.ledger.record(
          {
            ...owner,
            bookingId: null,
            type: LedgerEntryType.PAYOUT,
            amount: -current.balance,
            note: `payout ${String(doc._id)}`,
          },
          session,
        );
        return doc.toObject();
      });
      if (payout) created.push(payout);
    }
    await this.audit.log(context, {
      action: 'payout.generate',
      entityType: 'payout_batch',
      entityId: batchDate,
      metadata: { count: created.length, total: created.reduce((sum, p) => sum + p.amount, 0) },
    });
    return created;
  }

  // ── Admin ──

  async adminList(filters: { status?: PayoutStatus }, pagination: Pagination) {
    const query = filters.status ? { status: filters.status } : {};
    const [data, total] = await Promise.all([
      PayoutModel.find(query).sort({ createdAt: 1 }).skip(pagination.skip).limit(pagination.perPage).lean(),
      PayoutModel.countDocuments(query),
    ]);
    const names = await this.ownerNames(data);
    return {
      total,
      data: data.map((payout) => ({
        payout,
        ...names(payout),
        // Whoever pays needs the full account number; it's decrypted only here, for admins.
        destination: JSON.parse(decryptNullable(payout.destination) ?? '{}') as Record<string, string | null>,
      })),
    };
  }

  /** pending → approved, in bulk. Ids that aren't pending are reported back, not changed. */
  async approve(ids: string[], context: AuditContext) {
    const validIds = ids.filter((id) => Types.ObjectId.isValid(id));
    const now = new Date();
    const pending = await PayoutModel.find({ _id: { $in: validIds }, status: PayoutStatus.PENDING })
      .select('_id')
      .lean();
    await PayoutModel.updateMany(
      { _id: { $in: pending.map((p) => p._id) }, status: PayoutStatus.PENDING },
      { status: PayoutStatus.APPROVED, approvedBy: context.actorId, approvedAt: now },
    );
    const approved = pending.map((p) => String(p._id));
    await this.audit.log(context, {
      action: 'payout.approve',
      entityType: 'payout',
      metadata: { approved, skipped: ids.filter((id) => !approved.includes(id)) },
    });
    return { approved, skipped: ids.filter((id) => !approved.includes(id)) };
  }

  /** approved → paid with the bank / wallet transfer reference; tells the provider. */
  async markPaid(id: string, reference: string, context: AuditContext) {
    const payout = Types.ObjectId.isValid(id)
      ? await PayoutModel.findOneAndUpdate(
          { _id: id, status: PayoutStatus.APPROVED },
          { status: PayoutStatus.PAID, reference, paidBy: context.actorId, paidAt: new Date() },
          { new: true, lean: true },
        )
      : null;
    if (!payout) throw await this.statusError(id);
    await this.audit.log(context, {
      action: 'payout.mark_paid',
      entityType: 'payout',
      entityId: id,
      metadata: { reference },
    });
    const userId = await this.ownerUserId(payout);
    if (userId) {
      await this.notifications.notify([userId], {
        type: NotificationType.PAYOUT,
        template: 'payout_paid',
        params: {
          amount: (payout.amount / 100).toFixed(2),
          destination: payout.destinationLabel,
          earnings: (payout.statement.cardEarnings / 100).toFixed(2),
          commission: (payout.statement.commissionDeducted / 100).toFixed(2),
        },
        data: { payout_id: id },
      });
    }
    return payout;
  }

  /** pending / approved → cancelled (e.g. wrong account); the amount goes back to the balance. */
  async cancel(id: string, reason: string, context: AuditContext) {
    const payout = await withTransaction(async (session) => {
      const doc = Types.ObjectId.isValid(id)
        ? await PayoutModel.findOneAndUpdate(
            { _id: id, status: { $in: [PayoutStatus.PENDING, PayoutStatus.APPROVED] } },
            {
              status: PayoutStatus.CANCELLED,
              cancelledBy: context.actorId,
              cancelledAt: new Date(),
              cancelReason: reason,
            },
            { new: true, lean: true, session },
          )
        : null;
      if (!doc) return null;
      await this.ledger.record(
        {
          ownerType: doc.ownerType,
          ownerId: doc.ownerId,
          bookingId: null,
          type: LedgerEntryType.ADJUSTMENT,
          amount: doc.amount,
          note: `payout ${id} cancelled`,
        },
        session,
      );
      return doc;
    });
    if (!payout) throw await this.statusError(id);
    await this.audit.log(context, {
      action: 'payout.cancel',
      entityType: 'payout',
      entityId: id,
      metadata: { reason },
    });
    return payout;
  }

  /**
   * GET /admin/commission-dues — providers and organizations owing the platform (cash commission,
   * subscription fees), most owed first.
   */
  async commissionDues(pagination: Pagination) {
    const query = { ownerType: { $in: [PROVIDER, ORGANIZATION] }, balance: { $lt: 0 } };
    const [wallets, total] = await Promise.all([
      WalletBalanceModel.find(query)
        .sort({ balance: 1 })
        .skip(pagination.skip)
        .limit(pagination.perPage)
        .lean(),
      WalletBalanceModel.countDocuments(query),
    ]);
    const names = await this.ownerNames(wallets);
    return { total, data: wallets.map((w) => ({ wallet: w, ...names(w) })) };
  }

  /** POST /admin/ledger/adjustment — a manual credit (+) or debit (−). Audited. */
  async adjust(
    input: { ownerType: LedgerOwnerType; ownerId: string; amount: number; reason: string },
    context: AuditContext,
  ) {
    const owner = !Types.ObjectId.isValid(input.ownerId)
      ? null
      : input.ownerType === ORGANIZATION
        ? await OrganizationModel.exists({ _id: input.ownerId })
        : await ProviderProfileModel.exists({ _id: input.ownerId });
    if (!owner) throw new ValidationError({ owner_id: ['validation.not_found'] });
    const entry = await withTransaction((session) =>
      this.ledger.record(
        {
          ownerType: input.ownerType,
          ownerId: new Types.ObjectId(input.ownerId),
          bookingId: null,
          type: LedgerEntryType.ADJUSTMENT,
          amount: input.amount,
          note: input.reason,
        },
        session,
      ),
    );
    await this.audit.log(context, {
      action: 'ledger.adjustment',
      entityType: input.ownerType === ORGANIZATION ? 'organization' : 'provider_profile',
      entityId: input.ownerId,
      metadata: { amount: input.amount, reason: input.reason, entryId: String(entry._id) },
    });
    return entry.toObject();
  }

  /**
   * What makes up a payout (product decision): the ledger entries since the provider's previous payout,
   * grouped — card earnings, commission deducted for cash bookings, commission they paid, other
   * deductions (dispute refunds), adjustments. They add up to the amount paid; any rounding gap from
   * older history lands in adjustments so the statement always balances.
   */
  async statementSinceLastPayout(of: Types.ObjectId | EarningsOwner, amount: number, session: ClientSession) {
    const owner = asOwner(of);
    const lastPayout = await WalletLedgerModel.findOne({ ...owner, type: LedgerEntryType.PAYOUT })
      .sort({ createdAt: -1, _id: -1 })
      .session(session)
      .lean();
    const entries = await WalletLedgerModel.find({
      ...owner,
      type: { $ne: LedgerEntryType.PAYOUT },
      ...(lastPayout ? { _id: { $gt: lastPayout._id } } : {}),
    })
      .session(session)
      .lean();
    const sum = (type: LedgerEntryType) =>
      entries.filter((e) => e.type === type).reduce((t, e) => t + e.amount, 0);
    const cardEarnings = sum(LedgerEntryType.CREDIT);
    const commissionDeducted = -sum(LedgerEntryType.COMMISSION_DUE);
    const commissionPaid = sum(LedgerEntryType.COMMISSION_PAYMENT);
    const otherDeductions = -sum(LedgerEntryType.DEBIT);
    const discountsReimbursed = sum(LedgerEntryType.DISCOUNT_REIMBURSEMENT);
    const referralRewards = sum(LedgerEntryType.REFERRAL_REWARD);
    // Organizations: plan fees net of credits for unused time when changing plan.
    const subscriptionFees = -(
      sum(LedgerEntryType.SUBSCRIPTION_FEE) + sum(LedgerEntryType.SUBSCRIPTION_CREDIT)
    );
    const known =
      cardEarnings -
      commissionDeducted +
      commissionPaid +
      discountsReimbursed +
      referralRewards -
      otherDeductions -
      subscriptionFees;
    return {
      cardEarnings,
      commissionDeducted,
      commissionPaid,
      discountsReimbursed,
      referralRewards,
      subscriptionFees,
      otherDeductions,
      adjustments: amount - known,
      net: amount,
    };
  }

  async balance(of: Types.ObjectId | EarningsOwner) {
    return (await WalletBalanceModel.findOne(asOwner(of)).lean())?.balance ?? 0;
  }

  private async statusError(id: string) {
    const exists = Types.ObjectId.isValid(id) ? await PayoutModel.exists({ _id: id }) : null;
    return exists
      ? new ConflictError('errors.payout_wrong_status')
      : new NotFoundError('errors.payout_not_found');
  }

  /** Who the user to notify is: the provider, or the organization's owner. */
  private async ownerUserId(owner: EarningsOwner) {
    return owner.ownerType === ORGANIZATION
      ? (await OrganizationModel.findById(owner.ownerId).select('ownerUserId').lean())?.ownerUserId
      : (await ProviderProfileModel.findById(owner.ownerId).select('userId').lean())?.userId;
  }

  /** For admin lists: `provider` for a provider's row, `organization` for an organization's (the other null). */
  private async ownerNames(rows: EarningsOwner[]) {
    const ids = (type: LedgerOwnerType) => rows.filter((r) => r.ownerType === type).map((r) => r.ownerId);
    const [profiles, orgs] = await Promise.all([
      ProviderProfileModel.find({ _id: { $in: ids(PROVIDER) } })
        .select('userId')
        .setOptions({ withDeleted: true })
        .lean(),
      OrganizationModel.find({ _id: { $in: ids(ORGANIZATION) } })
        .select('name ownerUserId phone')
        .setOptions({ withDeleted: true })
        .lean(),
    ]);
    const users = await UserModel.find({
      _id: { $in: [...profiles.map((p) => p.userId), ...orgs.map((o) => o.ownerUserId)] },
    })
      .select('fullName phone')
      .setOptions({ withDeleted: true })
      .lean();
    const userById = new Map(users.map((u) => [String(u._id), u]));
    const providers = new Map(
      profiles.map((p) => {
        const user = userById.get(String(p.userId));
        return [
          String(p._id),
          { id: String(p._id), name: user?.fullName ?? '', phone: user?.phone ?? '' },
        ] as const;
      }),
    );
    const organizations = new Map(
      orgs.map((o) => {
        const ownerUser = userById.get(String(o.ownerUserId));
        return [
          String(o._id),
          { id: String(o._id), name: o.name, phone: o.phone ?? ownerUser?.phone ?? '' },
        ] as const;
      }),
    );
    return (row: EarningsOwner) => ({
      ownerType: row.ownerType,
      provider: row.ownerType === PROVIDER ? (providers.get(String(row.ownerId)) ?? null) : null,
      organization: row.ownerType === ORGANIZATION ? (organizations.get(String(row.ownerId)) ?? null) : null,
    });
  }
}
