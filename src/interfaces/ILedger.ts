import type { Types } from 'mongoose';

export enum LedgerOwnerType {
  PROVIDER = 'provider',
  ORGANIZATION = 'organization',
  /** A patient's in-app credit (referral rewards), owner = the user id. Spent on bookings, never paid out. */
  PATIENT = 'patient',
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
  /** Cash booking with a discount: the platform bears it, so it owes the provider what they didn't collect. */
  DISCOUNT_REIMBURSEMENT = 'discount_reimbursement',
  /** Referral reward (patient credit or provider earnings). */
  REFERRAL_REWARD = 'referral_reward',
  /** Patient credit spent on a booking (negative). */
  CREDIT_USED = 'credit_used',
  /** Credit given back when that booking ended without a visit. */
  CREDIT_RESTORED = 'credit_restored',
  /** Organizations: a month of their plan (negative; netted from earnings — decision M3.4). */
  SUBSCRIPTION_FEE = 'subscription_fee',
  /** Organizations: the unused part of a paid month given back when changing plan. */
  SUBSCRIPTION_CREDIT = 'subscription_credit',
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
