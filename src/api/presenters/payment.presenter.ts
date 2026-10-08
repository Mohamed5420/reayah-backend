import type { IPayment, IRefund } from '../../interfaces/IPayment';
import { PaymentRecordStatus } from '../../interfaces/IPayment';

/** Maps payments to the API shapes in payment.validation.ts. */

export const presentPayment = (p: IPayment) => ({
  id: String(p._id),
  booking_id: String(p.bookingId),
  purpose: p.purpose,
  amount: p.amount,
  currency: p.currency,
  method: p.method,
  status: p.status,
  checkout_url: p.status === PaymentRecordStatus.PENDING ? p.checkoutUrl : null,
  expires_at: p.expiresAt.toISOString(),
  paid_at: p.paidAt ? p.paidAt.toISOString() : null,
  refunded_amount: p.refundedAmount,
  instrument: p.instrument ? { brand: p.instrument.brand ?? null, last4: p.instrument.last4 ?? null } : null,
  failure_reason: p.failureReason,
  created_at: p.createdAt.toISOString(),
});

export const presentRefund = (r: IRefund) => ({
  id: String(r._id),
  payment_id: String(r.paymentId),
  booking_id: String(r.bookingId),
  amount: r.amount,
  reason: r.reason,
  status: r.status,
  created_at: r.createdAt.toISOString(),
});
