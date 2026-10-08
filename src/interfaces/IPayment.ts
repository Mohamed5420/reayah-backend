import type { Types } from 'mongoose';
import type { PaymentMethod } from './IBooking';

/** Spec §7.14 `purpose`. */
export enum PaymentPurpose {
  BOOKING = 'booking',
  /** Buying a package (spec §7.9). */
  PACKAGE = 'package',
  /** A provider paying the commission they owe on cash bookings. */
  COMMISSION = 'commission',
  /** An organization paying its unpaid plan fees. */
  PLAN_FEE = 'plan_fee',
}

/** One checkout attempt. A booking can have several (a failed card, then a retry). */
export enum PaymentRecordStatus {
  PENDING = 'pending',
  PAID = 'paid',
  FAILED = 'failed',
  /** The patient never finished paying within the payment window. */
  EXPIRED = 'expired',
  PARTIALLY_REFUNDED = 'partially_refunded',
  REFUNDED = 'refunded',
}

export enum RefundStatus {
  PENDING = 'pending',
  SUCCEEDED = 'succeeded',
  FAILED = 'failed',
}

/** Gateways we can talk to. `fake` is for development and tests only (refused in production). */
export enum GatewayName {
  PAYMOB = 'paymob',
  FAKE = 'fake',
}

/** Spec §4.8 `payments`. Card data never reaches us: only the gateway's masked last digits and brand. */
export interface IPayment {
  _id: Types.ObjectId;
  purpose: PaymentPurpose;
  /** Booking payments only. */
  bookingId: Types.ObjectId | null;
  /** Commission payments only: whose ledger is credited (a provider, or `organizationId`). */
  providerProfileId: Types.ObjectId | null;
  /** An organization paying what it owes (cash commission, plan fees). */
  organizationId: Types.ObjectId | null;
  /** Package purchases only. */
  packageSubscriptionId: Types.ObjectId | null;
  userId: Types.ObjectId;
  /** Piastres. */
  amount: number;
  currency: 'EGP';
  method: PaymentMethod.CARD | PaymentMethod.WALLET;
  gateway: GatewayName;
  status: PaymentRecordStatus;
  /** The gateway's id for this checkout (Paymob: the intention's order id). */
  gatewayOrderId: string | null;
  /** The gateway's id for the successful transaction — needed for refunds. */
  gatewayTransactionId: string | null;
  checkoutUrl: string | null;
  expiresAt: Date;
  paidAt: Date | null;
  refundedAmount: number;
  /** e.g. `{ brand: "MasterCard", last4: "2346" }` or the wallet type — for receipts. */
  instrument: { brand: string | null; last4: string | null } | null;
  failureReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Spec §4.8 `refunds`. */
export interface IRefund {
  _id: Types.ObjectId;
  paymentId: Types.ObjectId;
  /** null for package purchases. */
  bookingId: Types.ObjectId | null;
  amount: number;
  reason: string;
  status: RefundStatus;
  gatewayRefundId: string | null;
  /** Admin who asked for it; null = automatic (cancellation, expiry). */
  requestedBy: Types.ObjectId | null;
  failureReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}
