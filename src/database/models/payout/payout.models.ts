import { Schema, model } from 'mongoose';
import { LedgerOwnerType } from '../../../interfaces/ILedger';
import {
  PayoutMethodType,
  PayoutStatus,
  WALLET_PROVIDERS,
  type IPayout,
  type IPayoutMethod,
} from '../../../interfaces/IPayout';
import { baseSchemaOptions, piastresValidator } from '../../schema-options';
import { encryptOnWrite, encryptedString } from '../../../utils/crypto/field-encryption';

const payoutMethodSchema = new Schema<IPayoutMethod>(
  {
    ownerType: { type: String, enum: Object.values(LedgerOwnerType), required: true },
    ownerId: { type: Schema.Types.ObjectId, required: true },
    type: { type: String, enum: Object.values(PayoutMethodType), required: true },
    accountHolder: { type: String, required: true },
    bankName: { type: String, default: null },
    walletProvider: { type: String, enum: [...WALLET_PROVIDERS, null], default: null },
    accountNumber: encryptedString({ required: true }),
  },
  { ...baseSchemaOptions, toJSON: { getters: true }, toObject: { getters: true } },
);
payoutMethodSchema.index({ ownerType: 1, ownerId: 1 }, { unique: true });

export const PayoutMethodModel = model<IPayoutMethod>('PayoutMethod', payoutMethodSchema, 'payout_methods');

/** Financial records: never deleted. */
const payoutSchema = new Schema<IPayout>(
  {
    ownerType: { type: String, enum: Object.values(LedgerOwnerType), required: true },
    ownerId: { type: Schema.Types.ObjectId, required: true },
    amount: { type: Number, required: true, validate: piastresValidator },
    status: { type: String, enum: Object.values(PayoutStatus), default: PayoutStatus.PENDING },
    destination: encryptOnWrite({ required: true }),
    destinationLabel: { type: String, required: true },
    statement: {
      cardEarnings: { type: Number, default: 0 },
      commissionDeducted: { type: Number, default: 0 },
      commissionPaid: { type: Number, default: 0 },
      otherDeductions: { type: Number, default: 0 },
      adjustments: { type: Number, default: 0 },
      net: { type: Number, default: 0 },
    },
    batchDate: { type: String, required: true },
    reference: { type: String, default: null },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    approvedAt: { type: Date, default: null },
    paidBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    paidAt: { type: Date, default: null },
    cancelledBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    cancelledAt: { type: Date, default: null },
    cancelReason: { type: String, default: null },
  },
  baseSchemaOptions,
);
payoutSchema.index({ status: 1, createdAt: 1 });
payoutSchema.index({ ownerType: 1, ownerId: 1, createdAt: -1 });
// At most one open payout per owner: a new batch never double-pays while one is in flight.
payoutSchema.index(
  { ownerType: 1, ownerId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: [PayoutStatus.PENDING, PayoutStatus.APPROVED] } },
  },
);

export const PayoutModel = model<IPayout>('Payout', payoutSchema);
