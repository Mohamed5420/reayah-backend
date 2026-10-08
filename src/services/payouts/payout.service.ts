import { Container, Service } from 'typedi';
import { Types, type ClientSession } from 'mongoose';
import { withTransaction } from '../../database/transaction';
import { BookingModel } from '../../database/models/booking/booking.model';
import { WalletBalanceModel, WalletLedgerModel } from '../../database/models/ledger/wallet.model';
import { PayoutMethodModel, PayoutModel } from '../../database/models/payout/payout.models';
import { ProviderProfileModel } from '../../database/models/provider/provider-profile.model';
import { UserModel } from '../../database/models/user/user.model';
import { getRedis } from '../../config/redis.config';
import { BookingStatus } from '../../interfaces/IBooking';
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
import { addDays, cairoDate, cairoToUtc, dayOfWeek } from '../../utils/time/cairo';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/types-errors';
import { AuditService, SYSTEM_AUDIT_CONTEXT, type AuditContext } from '../audit/audit.service';
import { LedgerService } from '../ledger/ledger.service';
import { NotificationService } from '../notification/notification.service';
import { SettingsService } from '../settings/settings.service';
import { WEEKDAYS } from '../settings/settings.definitions';

const PROVIDER = LedgerOwnerType.PROVIDER;

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
 * Organizations get the same flow in Phase 3 (owner type `organization`).
 */
@Service()
export class PayoutService {
  private readonly ledger = Container.get(LedgerService);
  private readonly settings = Container.get(SettingsService);
  private readonly audit = Container.get(AuditService);
  private readonly notifications = Container.get(NotificationService);

  // ── Provider ──

  async getMethod(ownerId: Types.ObjectId) {
    const method = await PayoutMethodModel.findOne({ ownerType: PROVIDER, ownerId });
    return method ? (method.toObject() as IPayoutMethod) : null;
  }

  async setMethod(ownerId: Types.ObjectId, input: PayoutMethodInput) {
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
    const method =
      (await PayoutMethodModel.findOne({ ownerType: PROVIDER, ownerId })) ??
      new PayoutMethodModel({ ownerType: PROVIDER, ownerId });
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
  async earnings(ownerId: Types.ObjectId, from: string, to: string) {
    const [totals] = await BookingModel.aggregate<{
      visits: number;
      gross: number;
      commission: number;
      net: number;
    }>([
      {
        $match: {
          providerProfileId: ownerId,
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
    const balance = await this.balance(ownerId);
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

  async ledgerEntries(ownerId: Types.ObjectId, pagination: Pagination) {
    const query = { ownerType: PROVIDER, ownerId };
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

  async payoutsOf(ownerId: Types.ObjectId, pagination: Pagination) {
    const query = { ownerType: PROVIDER, ownerId };
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
      ownerType: PROVIDER,
      balance: { $gte: minimum },
    }).lean();
    const created: IPayout[] = [];
    for (const wallet of candidates) {
      const method = await PayoutMethodModel.findOne({ ownerType: PROVIDER, ownerId: wallet.ownerId });
      if (!method) continue;
      const open = await PayoutModel.exists({
        ownerType: PROVIDER,
        ownerId: wallet.ownerId,
        status: { $in: [PayoutStatus.PENDING, PayoutStatus.APPROVED] },
      });
      if (open) continue;
      const plain = method.toObject() as IPayoutMethod;
      const payout = await withTransaction(async (session) => {
        // Re-read inside the transaction: the balance may have moved since the scan.
        const current = await WalletBalanceModel.findOne(
          { ownerType: PROVIDER, ownerId: wallet.ownerId },
          null,
          {
            session,
          },
        ).lean();
        if (!current || current.balance < minimum) return null;
        const statement = await this.statementSinceLastPayout(wallet.ownerId, current.balance, session);
        const [doc] = await PayoutModel.create(
          [
            {
              ownerType: PROVIDER,
              ownerId: wallet.ownerId,
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
            ownerType: PROVIDER,
            ownerId: wallet.ownerId,
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
    const names = await this.providerNames(data.map((p) => p.ownerId));
    return {
      total,
      data: data.map((payout) => ({
        payout,
        provider: names.get(String(payout.ownerId)) ?? null,
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
    const profile = await ProviderProfileModel.findById(payout.ownerId).select('userId').lean();
    if (profile) {
      await this.notifications.notify([profile.userId], {
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

  /** GET /admin/commission-dues — providers owing the platform (cash commission), most owed first. */
  async commissionDues(pagination: Pagination) {
    const query = { ownerType: PROVIDER, balance: { $lt: 0 } };
    const [wallets, total] = await Promise.all([
      WalletBalanceModel.find(query)
        .sort({ balance: 1 })
        .skip(pagination.skip)
        .limit(pagination.perPage)
        .lean(),
      WalletBalanceModel.countDocuments(query),
    ]);
    const names = await this.providerNames(wallets.map((w) => w.ownerId));
    return {
      total,
      data: wallets.map((w) => ({ wallet: w, provider: names.get(String(w.ownerId)) ?? null })),
    };
  }

  /** POST /admin/ledger/adjustment — a manual credit (+) or debit (−). Audited. */
  async adjust(
    input: { ownerType: LedgerOwnerType; ownerId: string; amount: number; reason: string },
    context: AuditContext,
  ) {
    if (input.ownerType !== PROVIDER)
      throw new ValidationError({ owner_type: ['validation.organizations_not_available'] });
    const owner = Types.ObjectId.isValid(input.ownerId)
      ? await ProviderProfileModel.exists({ _id: input.ownerId })
      : null;
    if (!owner) throw new ValidationError({ owner_id: ['validation.not_found'] });
    const entry = await withTransaction((session) =>
      this.ledger.record(
        {
          ownerType: PROVIDER,
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
      entityType: 'provider_profile',
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
  async statementSinceLastPayout(ownerId: Types.ObjectId, amount: number, session: ClientSession) {
    const lastPayout = await WalletLedgerModel.findOne({
      ownerType: PROVIDER,
      ownerId,
      type: LedgerEntryType.PAYOUT,
    })
      .sort({ createdAt: -1, _id: -1 })
      .session(session)
      .lean();
    const entries = await WalletLedgerModel.find({
      ownerType: PROVIDER,
      ownerId,
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
    const known =
      cardEarnings -
      commissionDeducted +
      commissionPaid +
      discountsReimbursed +
      referralRewards -
      otherDeductions;
    return {
      cardEarnings,
      commissionDeducted,
      commissionPaid,
      discountsReimbursed,
      referralRewards,
      otherDeductions,
      adjustments: amount - known,
      net: amount,
    };
  }

  async balance(ownerId: Types.ObjectId) {
    return (await WalletBalanceModel.findOne({ ownerType: PROVIDER, ownerId }).lean())?.balance ?? 0;
  }

  private async statusError(id: string) {
    const exists = Types.ObjectId.isValid(id) ? await PayoutModel.exists({ _id: id }) : null;
    return exists
      ? new ConflictError('errors.payout_wrong_status')
      : new NotFoundError('errors.payout_not_found');
  }

  private async providerNames(profileIds: Types.ObjectId[]) {
    const profiles = await ProviderProfileModel.find({ _id: { $in: profileIds } })
      .select('userId')
      .setOptions({ withDeleted: true })
      .lean();
    const users = await UserModel.find({ _id: { $in: profiles.map((p) => p.userId) } })
      .select('fullName phone')
      .setOptions({ withDeleted: true })
      .lean();
    const userById = new Map(users.map((u) => [String(u._id), u]));
    return new Map(
      profiles.map((p) => {
        const user = userById.get(String(p.userId));
        return [
          String(p._id),
          { id: String(p._id), name: user?.fullName ?? '', phone: user?.phone ?? '' },
        ] as const;
      }),
    );
  }
}
