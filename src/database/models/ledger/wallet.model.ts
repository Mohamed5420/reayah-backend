import { Schema, model } from 'mongoose';
import {
  LedgerEntryType,
  LedgerOwnerType,
  type IWalletBalance,
  type IWalletLedgerEntry,
} from '../../../interfaces/ILedger';

const walletLedgerSchema = new Schema<IWalletLedgerEntry>(
  {
    ownerType: { type: String, enum: Object.values(LedgerOwnerType), required: true },
    ownerId: { type: Schema.Types.ObjectId, required: true },
    bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', default: null },
    type: { type: String, enum: Object.values(LedgerEntryType), required: true },
    amount: { type: Number, required: true, validate: Number.isInteger },
    balanceAfter: { type: Number, required: true },
    note: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

walletLedgerSchema.index({ ownerType: 1, ownerId: 1, createdAt: -1 });
// A booking produces at most one entry of each type (guards against double-processing).
walletLedgerSchema.index(
  { bookingId: 1, type: 1 },
  { unique: true, partialFilterExpression: { bookingId: { $type: 'objectId' } } },
);

// Money history is never edited — corrections are new `adjustment` entries.
walletLedgerSchema.pre(
  ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace'],
  () => {
    throw new Error('wallet_ledger is append-only');
  },
);

export const WalletLedgerModel = model<IWalletLedgerEntry>(
  'WalletLedger',
  walletLedgerSchema,
  'wallet_ledger',
);

const walletBalanceSchema = new Schema<IWalletBalance>(
  {
    ownerType: { type: String, enum: Object.values(LedgerOwnerType), required: true },
    ownerId: { type: Schema.Types.ObjectId, required: true },
    balance: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: false, updatedAt: true }, versionKey: false },
);

walletBalanceSchema.index({ ownerType: 1, ownerId: 1 }, { unique: true });

export const WalletBalanceModel = model<IWalletBalance>(
  'WalletBalance',
  walletBalanceSchema,
  'wallet_balances',
);
