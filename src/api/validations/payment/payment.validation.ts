import { PaymentMethod } from '../../../interfaces/IBooking';
import { PaymentPurpose, PaymentRecordStatus } from '../../../interfaces/IPayment';
import { objectId, paginationQuery, piastres, z } from '../zod';

const payment = z
  .object({
    id: objectId,
    /** null unless purpose = booking. */
    booking_id: objectId.nullable(),
    /** Set when purpose = package. */
    package_subscription_id: objectId.nullable(),
    purpose: z.enum(PaymentPurpose),
    amount: z.number(),
    currency: z.literal('EGP'),
    method: z.enum([PaymentMethod.CARD, PaymentMethod.WALLET]),
    status: z.enum(PaymentRecordStatus),
    /** Only while the payment is pending. */
    checkout_url: z.string().nullable(),
    expires_at: z.string(),
    paid_at: z.string().nullable(),
    refunded_amount: z.number(),
    /** Masked card digits / wallet, for receipts. */
    instrument: z.object({ brand: z.string().nullable(), last4: z.string().nullable() }).nullable(),
    failure_reason: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi('Payment');

/** Request and response schemas for payments (spec §7.14). */
export const PaymentSchemas = {
  idParams: z.object({ id: objectId }),
  gatewayParams: z.object({ gateway: z.string().min(1).max(20) }),
  initiateBody: z
    .strictObject({
      purpose: z.enum([PaymentPurpose.BOOKING, PaymentPurpose.PACKAGE]),
      /** Booking id, or package subscription id (an unpaid purchase). */
      reference_id: objectId,
      /** Switch between card and wallet before paying (optional). */
      method: z.enum([PaymentMethod.CARD, PaymentMethod.WALLET]).optional(),
    })
    .openapi('InitiatePayment'),
  initiated: z
    .object({ payment_id: objectId, checkout_url: z.string(), expires_at: z.string() })
    .openapi('PaymentInitiated'),
  payment,
  listQuery: paginationQuery,
  adminListQuery: paginationQuery.extend({
    status: z.enum(PaymentRecordStatus).optional(),
    method: z.enum([PaymentMethod.CARD, PaymentMethod.WALLET]).optional(),
  }),
  refundBody: z
    .strictObject({
      /** Piastres; omit for whatever is left of the payment. */
      amount: piastres.min(1).optional(),
      reason: z.string().trim().min(3).max(500),
    })
    .openapi('RefundRequest'),
  refund: z
    .object({
      id: objectId,
      payment_id: objectId,
      booking_id: objectId,
      amount: z.number(),
      reason: z.string(),
      status: z.enum(['pending', 'succeeded', 'failed']),
      created_at: z.string(),
    })
    .openapi('Refund'),
  webhookResult: z.object({ received: z.literal(true) }),
};
