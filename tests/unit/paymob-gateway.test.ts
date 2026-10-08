import { describe, expect, it, vi } from 'vitest';
import { PaymentMethod } from '../../src/interfaces/IBooking';
import {
  PaymobGateway,
  paymobTransactionHmac,
  type PaymobTransaction,
} from '../../src/services/payments/gateways/paymob.gateway';
import { InvalidWebhookSignatureError } from '../../src/services/payments/gateways';

const config = {
  apiUrl: 'https://accept.paymob.com',
  checkoutUrl: 'https://eg.checkout.paymob.com/',
  secretKey: 'egy_sk_test_123',
  publicKey: 'egy_pk_test_456',
  hmacSecret: 'HMAC_SECRET',
  integrations: { card: 111, wallet: 222 },
};

const transaction = (over: Partial<PaymobTransaction> = {}): PaymobTransaction => ({
  id: 192036465,
  amount_cents: 28000,
  created_at: '2026-10-08T03:24:46.195006',
  currency: 'EGP',
  error_occured: false,
  has_parent_transaction: false,
  integration_id: 111,
  is_3d_secure: true,
  is_auth: false,
  is_capture: false,
  is_refunded: false,
  is_standalone_payment: true,
  is_voided: false,
  order: { id: 217503754, merchant_order_id: '665f1c2b9e1d2a4c3b9e8f1a' },
  owner: 302852,
  pending: false,
  source_data: { pan: '2346', sub_type: 'MasterCard', type: 'card' },
  success: true,
  ...over,
});

const jsonResponse = (status: number, body: unknown) =>
  ({ ok: status < 400, status, json: () => Promise.resolve(body) }) as Response;

describe('Paymob gateway', () => {
  it('creates an intention (amount in piastres, the method’s integration) and builds the checkout URL', async () => {
    const http = vi
      .fn()
      .mockResolvedValue(jsonResponse(201, { client_secret: 'egy_csk_abc', intention_order_id: 217503754 }));
    const gateway = new PaymobGateway(config, http as unknown as typeof fetch);
    const result = await gateway.createCheckout({
      paymentId: '665f1c2b9e1d2a4c3b9e8f1a',
      amount: 28000,
      method: PaymentMethod.WALLET,
      description: 'غيار على جرح — RY-ABC123',
      customer: { firstName: 'منى', lastName: 'حسن', phone: '+201001234567', email: null },
      webhookUrl: 'https://api.reaya.app/api/v1/webhooks/payments/paymob',
      returnUrl: 'https://api.reaya.app/api/v1/payments/665f1c2b9e1d2a4c3b9e8f1a/return',
      expiresInSeconds: 900,
    });

    const [url, init] = http.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://accept.paymob.com/v1/intention/');
    expect((init.headers as Record<string, string>).Authorization).toBe('Token egy_sk_test_123');
    expect(JSON.parse(init.body as string)).toMatchObject({
      amount: 28000,
      currency: 'EGP',
      payment_methods: [222],
      special_reference: '665f1c2b9e1d2a4c3b9e8f1a',
      notification_url: 'https://api.reaya.app/api/v1/webhooks/payments/paymob',
      billing_data: { first_name: 'منى', last_name: 'حسن', phone_number: '+201001234567', email: 'NA' },
    });
    expect(result).toEqual({
      checkoutUrl: 'https://eg.checkout.paymob.com/?publicKey=egy_pk_test_456&clientSecret=egy_csk_abc',
      gatewayOrderId: '217503754',
    });
  });

  it('fails loudly when Paymob refuses the intention', async () => {
    const http = vi.fn().mockResolvedValue(jsonResponse(401, { detail: 'Invalid token' }));
    const gateway = new PaymobGateway(config, http as unknown as typeof fetch);
    await expect(
      gateway.createCheckout({
        paymentId: 'p',
        amount: 100,
        method: PaymentMethod.CARD,
        description: 'x',
        customer: { firstName: 'a', lastName: 'b', phone: '+201001234567', email: null },
        webhookUrl: 'w',
        returnUrl: 'r',
        expiresInSeconds: 60,
      }),
    ).rejects.toThrow(/Paymob intention failed \(401\)/);
  });

  it('accepts a callback whose HMAC matches and maps the result', () => {
    const gateway = new PaymobGateway(config);
    const tx = transaction();
    const event = gateway.parseWebhook({
      query: { hmac: paymobTransactionHmac(tx, config.hmacSecret) },
      body: { type: 'TRANSACTION', obj: tx },
      headers: {},
    });
    expect(event).toEqual({
      kind: 'transaction',
      paymentId: '665f1c2b9e1d2a4c3b9e8f1a',
      gatewayOrderId: '217503754',
      transactionId: '192036465',
      status: 'paid',
      amount: 28000,
      instrument: { brand: 'MasterCard', last4: '2346' },
      failureReason: null,
      isFollowUp: false,
    });
  });

  it('rejects a callback that was tampered with after signing', () => {
    const gateway = new PaymobGateway(config);
    const signed = paymobTransactionHmac(transaction({ success: false }), config.hmacSecret);
    expect(() =>
      gateway.parseWebhook({
        query: { hmac: signed },
        body: { obj: transaction({ success: true }) },
        headers: {},
      }),
    ).toThrow(InvalidWebhookSignatureError);
    expect(() => gateway.parseWebhook({ query: {}, body: { obj: transaction() }, headers: {} })).toThrow(
      InvalidWebhookSignatureError,
    );
  });

  it.each([
    [{ success: false, data: { message: 'Insufficient funds' } }, 'failed'],
    [{ pending: true, success: false }, 'pending'],
    [{ is_refunded: true }, 'refunded'],
    [{ is_voided: true }, 'voided'],
  ] as const)('maps %j to %s', (over, status) => {
    const gateway = new PaymobGateway(config);
    const tx = transaction(over as Partial<PaymobTransaction>);
    const event = gateway.parseWebhook({
      query: { hmac: paymobTransactionHmac(tx, config.hmacSecret) },
      body: { obj: tx },
      headers: {},
    });
    expect(event).toMatchObject({ kind: 'transaction', status });
  });

  it('refunds by transaction id', async () => {
    const http = vi.fn().mockResolvedValue(jsonResponse(200, { id: 555, success: true }));
    const gateway = new PaymobGateway(config, http as unknown as typeof fetch);
    expect(await gateway.refund({ transactionId: '192036465', amount: 5000 })).toEqual({
      ok: true,
      refundId: '555',
    });
    const [url, init] = http.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://accept.paymob.com/api/acceptance/void_refund/refund');
    expect(JSON.parse(init.body as string)).toEqual({ transaction_id: '192036465', amount_cents: 5000 });

    http.mockResolvedValueOnce(jsonResponse(400, { detail: 'Refund amount exceeds' }));
    expect(await gateway.refund({ transactionId: '1', amount: 1 })).toMatchObject({ ok: false });
  });
});
