import { createHmac, timingSafeEqual } from 'node:crypto';
import { PaymentMethod } from '../../../interfaces/IBooking';
import { GatewayName } from '../../../interfaces/IPayment';
import {
  InvalidWebhookSignatureError,
  type CheckoutInput,
  type CheckoutResult,
  type PaymentGateway,
  type WebhookEvent,
  type WebhookRequest,
} from './payment-gateway';

export type PaymobConfig = {
  /** API host, e.g. https://accept.paymob.com (sandbox and live share it; the keys decide). */
  apiUrl: string;
  /** Unified Checkout page, e.g. https://eg.checkout.paymob.com/ (Egypt). */
  checkoutUrl: string;
  secretKey: string;
  publicKey: string;
  hmacSecret: string;
  /** Integration ids from the Paymob dashboard, per payment method. */
  integrations: { card: number; wallet: number };
};

/**
 * Paymob (Egypt): cards + mobile wallets through the Intention API and Unified Checkout.
 * Docs: developers.paymob.com — create intention, HMAC transaction callback, refund.
 */
export class PaymobGateway implements PaymentGateway {
  readonly name = GatewayName.PAYMOB;

  constructor(
    private readonly config: PaymobConfig,
    private readonly http: typeof fetch = fetch,
  ) {}

  async createCheckout(input: CheckoutInput): Promise<CheckoutResult> {
    const response = await this.http(`${this.config.apiUrl}/v1/intention/`, {
      method: 'POST',
      headers: { Authorization: `Token ${this.config.secretKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: input.amount, // piastres = Paymob "cents"
        currency: 'EGP',
        payment_methods: [
          input.method === PaymentMethod.WALLET
            ? this.config.integrations.wallet
            : this.config.integrations.card,
        ],
        items: [{ name: input.description.slice(0, 50), amount: input.amount, quantity: 1 }],
        billing_data: {
          first_name: input.customer.firstName || 'NA',
          last_name: input.customer.lastName || 'NA',
          phone_number: input.customer.phone,
          email: input.customer.email ?? 'NA',
          country: 'EG',
        },
        special_reference: input.paymentId,
        notification_url: input.webhookUrl,
        redirection_url: input.returnUrl,
        expiration: input.expiresInSeconds,
      }),
    });
    const body = (await response.json().catch(() => ({}))) as {
      client_secret?: string;
      intention_order_id?: number | string;
      detail?: unknown;
    };
    if (!response.ok || !body.client_secret) {
      throw new Error(`Paymob intention failed (${response.status}): ${JSON.stringify(body).slice(0, 300)}`);
    }
    const url = new URL(this.config.checkoutUrl);
    url.searchParams.set('publicKey', this.config.publicKey);
    url.searchParams.set('clientSecret', body.client_secret);
    return { checkoutUrl: url.toString(), gatewayOrderId: String(body.intention_order_id ?? '') };
  }

  parseWebhook(request: WebhookRequest): WebhookEvent {
    const payload = request.body as { type?: string; obj?: PaymobTransaction } | undefined;
    const tx = payload?.obj;
    const received = typeof request.query.hmac === 'string' ? request.query.hmac : '';
    if (!tx || !received || !safeEqualHex(paymobTransactionHmac(tx, this.config.hmacSecret), received)) {
      throw new InvalidWebhookSignatureError();
    }
    if (payload.type && payload.type !== 'TRANSACTION')
      return { kind: 'ignored', reason: `type ${payload.type}` };

    const status = tx.is_voided
      ? 'voided'
      : tx.is_refunded
        ? 'refunded'
        : tx.pending
          ? 'pending'
          : tx.success
            ? 'paid'
            : 'failed';
    return {
      kind: 'transaction',
      paymentId: tx.order?.merchant_order_id ? String(tx.order.merchant_order_id) : null,
      gatewayOrderId: tx.order?.id !== undefined ? String(tx.order.id) : null,
      transactionId: String(tx.id),
      status,
      amount: Number(tx.amount_cents),
      instrument: tx.source_data
        ? { brand: tx.source_data.sub_type ?? tx.source_data.type ?? null, last4: tx.source_data.pan ?? null }
        : null,
      failureReason: status === 'failed' ? (tx.data?.message ?? 'declined') : null,
      isFollowUp: Boolean(tx.has_parent_transaction),
    };
  }

  async refund(input: { transactionId: string; amount: number }) {
    const response = await this.http(`${this.config.apiUrl}/api/acceptance/void_refund/refund`, {
      method: 'POST',
      headers: { Authorization: `Token ${this.config.secretKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ transaction_id: input.transactionId, amount_cents: input.amount }),
    });
    const body = (await response.json().catch(() => ({}))) as {
      id?: number | string;
      success?: boolean;
      detail?: string;
    };
    if (!response.ok || body.success === false) {
      return {
        ok: false,
        refundId: null,
        error: `Paymob refund failed (${response.status}): ${body.detail ?? ''}`,
      };
    }
    return { ok: true, refundId: body.id !== undefined ? String(body.id) : null };
  }
}

/** The fields of Paymob's "transaction processed" callback that we read. */
export type PaymobTransaction = {
  id: number | string;
  amount_cents: number | string;
  created_at: string;
  currency: string;
  error_occured: boolean;
  has_parent_transaction: boolean;
  integration_id: number | string;
  is_3d_secure: boolean;
  is_auth: boolean;
  is_capture: boolean;
  is_refunded: boolean;
  is_standalone_payment: boolean;
  is_voided: boolean;
  order: { id: number | string; merchant_order_id?: string | null };
  owner: number | string;
  pending: boolean;
  source_data: { pan?: string; sub_type?: string; type?: string };
  success: boolean;
  data?: { message?: string };
};

/** Paymob's documented order for the transaction-callback HMAC (SHA-512 over the concatenated values). */
const HMAC_FIELDS: Array<(tx: PaymobTransaction) => unknown> = [
  (tx) => tx.amount_cents,
  (tx) => tx.created_at,
  (tx) => tx.currency,
  (tx) => tx.error_occured,
  (tx) => tx.has_parent_transaction,
  (tx) => tx.id,
  (tx) => tx.integration_id,
  (tx) => tx.is_3d_secure,
  (tx) => tx.is_auth,
  (tx) => tx.is_capture,
  (tx) => tx.is_refunded,
  (tx) => tx.is_standalone_payment,
  (tx) => tx.is_voided,
  (tx) => tx.order?.id,
  (tx) => tx.owner,
  (tx) => tx.pending,
  (tx) => tx.source_data?.pan,
  (tx) => tx.source_data?.sub_type,
  (tx) => tx.source_data?.type,
  (tx) => tx.success,
];

export const paymobTransactionHmac = (tx: PaymobTransaction, secret: string) =>
  createHmac('sha512', secret)
    .update(HMAC_FIELDS.map((field) => String(field(tx) ?? '')).join(''))
    .digest('hex');

const safeEqualHex = (a: string, b: string) => {
  const left = Buffer.from(a.toLowerCase());
  const right = Buffer.from(b.toLowerCase());
  return left.length === right.length && timingSafeEqual(left, right);
};
