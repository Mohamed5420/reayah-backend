import type { Types } from 'mongoose';
import type { LedgerOwnerType } from './ILedger';

export enum PayoutMethodType {
  BANK = 'bank',
  WALLET = 'wallet',
}

/** Mobile wallets / instant transfer handles providers can be paid to. */
export const WALLET_PROVIDERS = [
  'vodafone_cash',
  'orange_cash',
  'etisalat_cash',
  'we_pay',
  'instapay',
] as const;
export type WalletProvider = (typeof WALLET_PROVIDERS)[number];

/** Where a provider (later: organization) wants to be paid. The account number is encrypted at rest. */
export interface IPayoutMethod {
  _id: Types.ObjectId;
  ownerType: LedgerOwnerType;
  ownerId: Types.ObjectId;
  type: PayoutMethodType;
  accountHolder: string;
  /** Bank: the bank's name. */
  bankName: string | null;
  walletProvider: WalletProvider | null;
  /** IBAN / account number, or the wallet's mobile number. Encrypted. */
  accountNumber: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Piastres. Deductions are positive numbers; net = cardEarnings − commissionDeducted + commissionPaid − otherDeductions + adjustments. */
export type PayoutStatement = {
  cardEarnings: number;
  commissionDeducted: number;
  commissionPaid: number;
  otherDeductions: number;
  adjustments: number;
  net: number;
};

export enum PayoutStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  PAID = 'paid',
  CANCELLED = 'cancelled',
}

/** Spec §4.8 `payouts`. The amount leaves the owner's balance (a `payout` ledger entry) when created. */
export interface IPayout {
  _id: Types.ObjectId;
  ownerType: LedgerOwnerType;
  ownerId: Types.ObjectId;
  amount: number;
  status: PayoutStatus;
  /** Payout method at generation time: JSON, encrypted (who paid it needs the full number). */
  destination: string;
  /** e.g. "بنك مصر •••• 4821" — safe to show anywhere. */
  destinationLabel: string;
  /** How the amount came together since the previous payout (ledger totals; net = amount). */
  statement: PayoutStatement;
  /** Cairo date of the batch that created it. */
  batchDate: string;
  reference: string | null;
  approvedBy: Types.ObjectId | null;
  approvedAt: Date | null;
  paidBy: Types.ObjectId | null;
  paidAt: Date | null;
  cancelledBy: Types.ObjectId | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}
