import { Container, Service } from 'typedi';
import { Types, type ClientSession } from 'mongoose';
import { WalletBalanceModel, WalletLedgerModel } from '../../database/models/ledger/wallet.model';
import { LedgerEntryType, LedgerOwnerType } from '../../interfaces/ILedger';
import type { IBooking } from '../../interfaces/IBooking';
import { ConflictError } from '../../utils/types-errors';
import { LedgerService } from '../ledger/ledger.service';
import { discountsOf } from '../booking/pricing';
import { PaymentMethod } from '../../interfaces/IBooking';

/** The travel-fee charge a covered booking paid with credit (kept from the patient, paid to the provider). */
export const creditKeptForFee = (booking: Pick<IBooking, 'paymentMethod' | 'patientFee'>) =>
  booking.paymentMethod === PaymentMethod.COVERED && booking.patientFee?.collected
    ? booking.patientFee.amount
    : 0;

const PATIENT = LedgerOwnerType.PATIENT;

/**
 * A patient's in-app credit (referral rewards, M2.5). Kept on the wallet ledger with owner type
 * `patient` (owner = user id). It is applied automatically to the patient's next bookings — as much
 * as each one needs — and given back if that booking ends without a visit. It is never paid out.
 */
@Service()
export class CreditService {
  private readonly ledger = Container.get(LedgerService);

  async balance(userId: string | Types.ObjectId) {
    const wallet = await WalletBalanceModel.findOne({ ownerType: PATIENT, ownerId: userId }).lean();
    return Math.max(wallet?.balance ?? 0, 0);
  }

  grant(userId: Types.ObjectId, amount: number, note: string, session: ClientSession) {
    return this.ledger.record(
      {
        ownerType: PATIENT,
        ownerId: userId,
        bookingId: null,
        type: LedgerEntryType.REFERRAL_REWARD,
        amount,
        note,
      },
      session,
    );
  }

  /** Spends credit on a new booking; 409 if the balance dropped since the quote. */
  async use(
    userId: Types.ObjectId,
    amount: number,
    booking: Pick<IBooking, '_id' | 'referenceCode'>,
    session: ClientSession,
  ) {
    if (amount <= 0) return;
    const wallet = await WalletBalanceModel.findOneAndUpdate(
      { ownerType: PATIENT, ownerId: userId, balance: { $gte: amount } },
      { $inc: { balance: -amount } },
      { new: true, session },
    );
    if (!wallet) throw new ConflictError('errors.credit_changed');
    await WalletLedgerModel.create(
      [
        {
          ownerType: PATIENT,
          ownerId: userId,
          bookingId: booking._id,
          type: LedgerEntryType.CREDIT_USED,
          amount: -amount,
          balanceAfter: wallet.balance,
          note: booking.referenceCode,
        },
      ],
      { session },
    );
  }

  /**
   * The booking ended without a visit: the credit it used comes back (once — one entry per booking),
   * except a travel-fee charge it paid on a covered booking (no-show / cancelled after "on the way"),
   * which goes to the provider instead.
   */
  async restore(booking: IBooking, session: ClientSession) {
    const credit = discountsOf(booking.price).credit - creditKeptForFee(booking);
    if (credit <= 0) return;
    await this.ledger.record(
      {
        ownerType: PATIENT,
        ownerId: booking.patientUserId,
        bookingId: booking._id,
        type: LedgerEntryType.CREDIT_RESTORED,
        amount: credit,
        note: booking.referenceCode,
      },
      session,
    );
  }
}
