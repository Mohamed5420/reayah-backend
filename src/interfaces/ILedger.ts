import type { Types } from 'mongoose';

export enum LedgerOwnerType {
  PROVIDER = 'provider',
  ORGANIZATION = 'organization',
}

/** Spec §4.8 `wallet_ledger.type`. */
export enum LedgerEntryType {
  CREDIT = 'credit',
  DEBIT = 'debit',
  PAYOUT = 'payout',
  ADJUSTMENT = 'adjustment',
  /** Cash bookings: the provider collected the money and owes the platform its commission. */
  COMMISSION_DUE = 'commission_due',
  /** The provider paid commission they owed, through the payment gateway. */
  COMMISSION_PAYMENT = 'commission_payment',
}

/**
 * One money movement. `amount` is signed (piastres): positive = the platform owes the owner more,
 * negative = the owner owes the platform. `balanceAfter` is the owner's running balance.
 */
export interface IWalletLedgerEntry {
  _id: Types.ObjectId;
  ownerType: LedgerOwnerType;
  ownerId: Types.ObjectId;
  bookingId: Types.ObjectId | null;
  type: LedgerEntryType;
  amount: number;
  balanceAfter: number;
  note: string | null;
  createdAt: Date;
}

/** Current balance per owner, updated atomically with each ledger entry. */
export interface IWalletBalance {
  _id: Types.ObjectId;
  ownerType: LedgerOwnerType;
  ownerId: Types.ObjectId;
  balance: number;
  updatedAt: Date;
}
