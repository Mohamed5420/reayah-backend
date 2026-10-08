import { createHmac, timingSafeEqual } from 'node:crypto';
import { GatewayName } from '../../../interfaces/IPayment';
import {
  InvalidWebhookSignatureError,
  type CheckoutInput,
  type PaymentGateway,
  type WebhookEvent,
  type WebhookRequest,
} from './payment-gateway';

/** Shared with tests and local tools; the fake gateway is refused in production. */
export const FAKE_GATEWAY_SECRET = 'fake-gateway-secret';

export type FakeWebhookBody = {
  payment_id: string;
  transaction_id: string;
  status: 'paid' | 'failed' | 'pending' | 'refunded' | 'voided';
  amount: number;
};

/** Signs a fake webhook the way the fake gateway expects (`x-fake-signature`). */
export const signFakeWebhook = (body: FakeWebhookBody) =>
  createHmac('sha256', FAKE_GATEWAY_SECRET).update(JSON.stringify(body)).digest('hex');

/**
 * Stand-in gateway for development, tests and staging before real keys exist: checkout URLs point
 * nowhere, results arrive as signed webhooks you send yourself, refunds always succeed.
 */
export class FakeGateway implements PaymentGateway {
  readonly name = GatewayName.FAKE;
  readonly refunds: Array<{ transactionId: string; amount: number }> = [];

  createCheckout(input: CheckoutInput) {
    return Promise.resolve({
      checkoutUrl: `https://fake-gateway.invalid/checkout/${input.paymentId}`,
      gatewayOrderId: `fake-order-${input.paymentId}`,
    });
  }

  parseWebhook(request: WebhookRequest): WebhookEvent {
    const body = request.body as FakeWebhookBody;
    const signature = String(request.headers['x-fake-signature'] ?? '');
    const expected = body ? signFakeWebhook(body) : '';
    if (
      !signature ||
      signature.length !== expected.length ||
      !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    ) {
      throw new InvalidWebhookSignatureError();
    }
    return {
      kind: 'transaction',
      paymentId: body.payment_id,
      gatewayOrderId: `fake-order-${body.payment_id}`,
      transactionId: body.transaction_id,
      status: body.status,
      amount: body.amount,
      instrument: { brand: 'Visa', last4: '4242' },
      failureReason: body.status === 'failed' ? 'declined' : null,
      isFollowUp: false,
    };
  }

  refund(input: { transactionId: string; amount: number }) {
    this.refunds.push(input);
    return Promise.resolve({ ok: true, refundId: `fake-refund-${this.refunds.length}` });
  }
}
