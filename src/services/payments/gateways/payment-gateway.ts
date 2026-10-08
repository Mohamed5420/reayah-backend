import type { PaymentMethod } from '../../../interfaces/IBooking';
import type { GatewayName } from '../../../interfaces/IPayment';

/**
 * What booking and payment code needs from a payment provider (Paymob today; Fawry or others later).
 * Nothing outside `services/payments/gateways` knows a provider's API.
 */
export interface PaymentGateway {
  readonly name: GatewayName;

  /** Starts a hosted checkout for one payment; the app opens `checkoutUrl` in a WebView. */
  createCheckout(input: CheckoutInput): Promise<CheckoutResult>;

  /**
   * Verifies a webhook's signature and reads what happened. Throws `InvalidWebhookSignatureError`
   * when the signature doesn't match — the caller must then ignore the request entirely.
   */
  parseWebhook(request: WebhookRequest): WebhookEvent;

  /** Refunds (part of) a successful transaction. */
  refund(input: {
    transactionId: string;
    amount: number;
  }): Promise<{ ok: boolean; refundId: string | null; error?: string }>;
}

export type CheckoutInput = {
  /** Our payment id — sent as the gateway's merchant reference so callbacks can be matched. */
  paymentId: string;
  /** Piastres. */
  amount: number;
  method: PaymentMethod.CARD | PaymentMethod.WALLET;
  description: string;
  customer: { firstName: string; lastName: string; phone: string; email: string | null };
  /** Where the gateway POSTs the result (our webhook). */
  webhookUrl: string;
  /** Where the customer's browser goes afterwards (we bounce it back into the app). */
  returnUrl: string;
  expiresInSeconds: number;
};

export type CheckoutResult = { checkoutUrl: string; gatewayOrderId: string };

export type WebhookRequest = {
  query: Record<string, unknown>;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
};

export type WebhookEvent =
  | {
      kind: 'transaction';
      /** Our payment id, when the gateway echoes it back. */
      paymentId: string | null;
      gatewayOrderId: string | null;
      transactionId: string;
      status: 'paid' | 'failed' | 'pending' | 'refunded' | 'voided';
      amount: number;
      instrument: { brand: string | null; last4: string | null } | null;
      failureReason: string | null;
      /** A refund / void transaction about an earlier payment, not a new payment result. */
      isFollowUp: boolean;
    }
  | { kind: 'ignored'; reason: string };

export class InvalidWebhookSignatureError extends Error {
  constructor() {
    super('Invalid webhook signature');
  }
}
