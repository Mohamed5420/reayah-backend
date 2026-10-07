import type { ClientSession, Types } from 'mongoose';
import { Service } from 'typedi';
import { WalletBalanceModel, WalletLedgerModel } from '../../database/models/ledger/wallet.model';
import { LedgerEntryType, LedgerOwnerType } from '../../interfaces/ILedger';
import { PaymentMethod, type IBooking } from '../../interfaces/IBooking';

/**
 * Provider / organization money (spec §4.8). Every movement is an append-only ledger entry; the
 * running balance is kept in `wallet_balances` and updated atomically in the same transaction.
 * Balance > 0: the platform owes the owner. Balance < 0: the owner owes the platform.
 */
@Service()
export class LedgerService {
  async record(
    entry: {
      ownerType: LedgerOwnerType;
      ownerId: Types.ObjectId;
      bookingId: Types.ObjectId | null;
      type: LedgerEntryType;
      amount: number;
      note?: string | null;
    },
    session: ClientSession,
  ) {
    const wallet = await WalletBalanceModel.findOneAndUpdate(
      { ownerType: entry.ownerType, ownerId: entry.ownerId },
      { $inc: { balance: entry.amount } },
      { upsert: true, new: true, session },
    );
    const [ledgerEntry] = await WalletLedgerModel.create(
      [{ ...entry, note: entry.note ?? null, balanceAfter: wallet.balance }],
      { session },
    );
    return ledgerEntry;
  }

  /**
   * On completion (spec §4.8): with cash, the provider collected the whole total, so the platform's
   * commission becomes a debit to settle. Card/wallet bookings (Phase 2) will credit the provider's share instead.
   */
  async recordCompletion(booking: IBooking, session: ClientSession) {
    if (booking.paymentMethod !== PaymentMethod.CASH || !booking.providerProfileId) return;
    if (booking.price.commissionAmount === 0) return;
    await this.record(
      {
        ownerType: LedgerOwnerType.PROVIDER,
        ownerId: booking.providerProfileId,
        bookingId: booking._id,
        type: LedgerEntryType.COMMISSION_DUE,
        amount: -booking.price.commissionAmount,
        note: booking.referenceCode,
      },
      session,
    );
  }
}
