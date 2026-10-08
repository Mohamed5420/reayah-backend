import { Schema, model } from 'mongoose';
import { PaymentMethod } from '../../../interfaces/IBooking';
import {
  GatewayName,
  PaymentPurpose,
  PaymentRecordStatus,
  RefundStatus,
  type IPayment,
  type IRefund,
} from '../../../interfaces/IPayment';
import { baseSchemaOptions, piastresValidator } from '../../schema-options';

/** Payments and refunds are financial records: never deleted, no soft delete. */
const paymentSchema = new Schema<IPayment>(
  {
    purpose: { type: String, enum: Object.values(PaymentPurpose), required: true },
    bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', default: null },
    providerProfileId: { type: Schema.Types.ObjectId, ref: 'ProviderProfile', default: null },
    packageSubscriptionId: { type: Schema.Types.ObjectId, ref: 'PackageSubscription', default: null },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    amount: { type: Number, required: true, validate: piastresValidator },
    currency: { type: String, enum: ['EGP'], default: 'EGP' },
    method: { type: String, enum: [PaymentMethod.CARD, PaymentMethod.WALLET], required: true },
    gateway: { type: String, enum: Object.values(GatewayName), required: true },
    status: { type: String, enum: Object.values(PaymentRecordStatus), default: PaymentRecordStatus.PENDING },
    gatewayOrderId: { type: String, default: null },
    gatewayTransactionId: { type: String, default: null },
    checkoutUrl: { type: String, default: null },
    expiresAt: { type: Date, required: true },
    paidAt: { type: Date, default: null },
    refundedAmount: { type: Number, default: 0, validate: piastresValidator },
    instrument: {
      type: new Schema({ brand: String, last4: String }, { _id: false }),
      default: null,
    },
    failureReason: { type: String, default: null },
  },
  baseSchemaOptions,
);
paymentSchema.index({ bookingId: 1, createdAt: -1 });
paymentSchema.index({ userId: 1, createdAt: -1 });
paymentSchema.index({ packageSubscriptionId: 1 }, { sparse: true });
paymentSchema.index({ gateway: 1, gatewayOrderId: 1 });
paymentSchema.index({ status: 1, expiresAt: 1 });
// At most one paid payment per booking (commission payments have no booking).
paymentSchema.index(
  { bookingId: 1 },
  {
    unique: true,
    partialFilterExpression: { purpose: PaymentPurpose.BOOKING, status: { $in: [PaymentRecordStatus.PAID] } },
  },
);

export const PaymentModel = model<IPayment>('Payment', paymentSchema);

const refundSchema = new Schema<IRefund>(
  {
    paymentId: { type: Schema.Types.ObjectId, ref: 'Payment', required: true, index: true },
    bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', default: null, index: true },
    amount: { type: Number, required: true, validate: piastresValidator },
    reason: { type: String, required: true },
    status: { type: String, enum: Object.values(RefundStatus), default: RefundStatus.PENDING },
    gatewayRefundId: { type: String, default: null },
    requestedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    failureReason: { type: String, default: null },
  },
  baseSchemaOptions,
);

export const RefundModel = model<IRefund>('Refund', refundSchema);
