import type { ClientSession, Types } from 'mongoose';
import { Service } from 'typedi';
import { WalletBalanceModel, WalletLedgerModel } from '../../database/models/ledger/wallet.model';
import { LedgerEntryType, LedgerOwnerType } from '../../interfaces/ILedger';
import { PaymentMethod, PaymentStatus, type IBooking } from '../../interfaces/IBooking';
import { earningsOwnerOf } from './earnings-owner';

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
   * commission becomes a debit to settle. With a paid card / wallet booking the platform holds the
   * money, so the provider is credited their share (subtotal − commission + travel fee).
   */
  async recordCompletion(booking: IBooking, session: ClientSession) {
    // Organization bookings earn for the organization, never the staff member.
    const owner = earningsOwnerOf(booking);
    if (!owner) return;
    if (booking.paymentMethod !== PaymentMethod.CASH) {
      // Card / wallet once paid; covered (package / credit) always — the platform holds that money.
      if (booking.paymentStatus !== PaymentStatus.PAID || booking.price.providerPayout === 0) return;
      await this.record(
        {
          ...owner,
          bookingId: booking._id,
          type: LedgerEntryType.CREDIT,
          amount: booking.price.providerPayout,
          note: booking.referenceCode,
        },
        session,
      );
      return;
    }
    if (booking.price.commissionAmount > 0) {
      await this.record(
        {
          ...owner,
          bookingId: booking._id,
          type: LedgerEntryType.COMMISSION_DUE,
          amount: -booking.price.commissionAmount,
          note: booking.referenceCode,
        },
        session,
      );
    }
    // The platform bears discounts (promo, package, credit): the provider collected that much less.
    if (booking.price.discount > 0) {
      await this.record(
        {
          ...owner,
          bookingId: booking._id,
          type: LedgerEntryType.DISCOUNT_REIMBURSEMENT,
          amount: booking.price.discount,
          note: booking.referenceCode,
        },
        session,
      );
    }
  }
}
