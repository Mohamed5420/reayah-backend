import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { Container } from 'typedi';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app';
import { useTestDatabase } from '../helpers/db';
import { createUserWithToken } from '../helpers/fixtures';
import { createBookingWorld, tomorrowAt } from '../helpers/booking-world';
import { BookingModel } from '../../src/database/models/booking/booking.model';
import { WalletBalanceModel, WalletLedgerModel } from '../../src/database/models/ledger/wallet.model';
import { PaymentModel } from '../../src/database/models/payment/payment.models';
import { UserRole } from '../../src/interfaces/enums';
import { SettingsService } from '../../src/services/settings';
import { registerMarketingListeners } from '../../src/services/marketing';
import { setGatewayForTests } from '../../src/services/payments/gateways';
import {
  FakeGateway,
  signFakeWebhook,
  type FakeWebhookBody,
} from '../../src/services/payments/gateways/fake.gateway';

/**
 * Phase 2 exit (BUILD_PLAN): card payment and payout reconcile end to end (payment → completion →
 * ledger → payout batch → mark paid), with chat, a promo code and a package on the way. Video (M2.6)
 * is deferred and not part of it.
 *
 * One provider (250 EGP visit, 30 EGP travel, 15% commission = 37.50) gets three visits:
 *   A. card, promo WELCOME20 (−50)      → patient pays 230 by card; provider credited 242.50
 *   B. cash                              → provider collects 280; owes 37.50 commission
 *   C. package visit (4 × 250 = 1,000)   → package covers 250, patient pays 30 travel in cash;
 *                                          provider owes 37.50, is reimbursed 250
 * Payout = 242.50 − 37.50 − 37.50 + 250 = 417.50.
 * Platform keeps: gateway in (230 + 1,000) − payout 417.50 = 812.50
 *   = commission 3 × 37.50 − promo 50 (= 62.50 earned) + 750 held for the 3 unused package visits.
 */

useTestDatabase();
const app = createTestApp();
registerMarketingListeners();

let admin: Awaited<ReturnType<typeof createUserWithToken>>;

beforeEach(async () => {
  admin = await createUserWithToken(UserRole.ADMIN);
  setGatewayForTests(new FakeGateway());
});

const api = (auth: string) => ({
  get: (path: string) => request(app).get(`/api/v1${path}`).set('Authorization', auth),
  post: (path: string, body?: object) =>
    request(app)
      .post(`/api/v1${path}`)
      .set('Authorization', auth)
      .set('Idempotency-Key', randomUUID())
      .send(body),
  put: (path: string, body: object) =>
    request(app).put(`/api/v1${path}`).set('Authorization', auth).send(body),
});

const webhook = (body: FakeWebhookBody) =>
  request(app)
    .post('/api/v1/webhooks/payments/fake')
    .set('x-fake-signature', signFakeWebhook(body))
    .send(body)
    .expect(200);

describe('Phase 2 exit', () => {
  it('payments, promo, package and chat reconcile with the payout to the piastre', async () => {
    const world = await createBookingWorld(app);
    const patient = await world.newPatient();
    const provider = await world.newProvider();
    await Container.get(SettingsService).update(
      { features: { video_consult: false, card_payment: true, packages: true } },
      { actorId: null },
    );
    const visit = async (bookingId: string) => {
      for (const step of ['accept', 'on-the-way', 'start', 'complete']) {
        await world.providerApi(provider, 'post', `/bookings/${bookingId}/${step}`).expect(200);
      }
    };
    const book = async (overrides: Record<string, unknown>, method: string) => {
      const quote = await world.quote(patient, provider, overrides);
      expect(quote.status).toBe(200);
      const res = await api(patient.auth).post('/bookings', {
        quote_token: quote.body.data.quote_token,
        payment_method: method,
      });
      expect(res.status).toBe(201);
      return res.body.data;
    };

    // A — card booking with a promo code, paid through the gateway webhook.
    await api(admin.auth)
      .post('/admin/promo-codes', { code: 'WELCOME20', type: 'percent', value: 20, max_discount: 10000 })
      .expect(201);
    const a = await book({ promo_code: 'WELCOME20', scheduled_start: tomorrowAt('09:00') }, 'card');
    expect(a.status).toBe('awaiting_payment');
    await webhook({
      payment_id: a.payment_action.payment_id,
      transaction_id: 'tx-a',
      status: 'paid',
      amount: 23000,
    });
    expect((await BookingModel.findById(a.id).lean())!.status).toBe('pending');

    // Chat on the booking, both ways.
    await world.providerApi(provider, 'post', `/bookings/${a.id}/accept`).expect(200);
    await api(patient.auth)
      .post(`/bookings/${a.id}/messages`, { body: 'الجرس لا يعمل، اتصلي عند الوصول' })
      .expect(201);
    await api(provider.auth).post(`/bookings/${a.id}/messages`, { body: 'تمام' }).expect(201);
    expect((await api(patient.auth).get(`/bookings/${a.id}/messages`)).body.data).toHaveLength(2);
    for (const step of ['on-the-way', 'start', 'complete']) {
      await world.providerApi(provider, 'post', `/bookings/${a.id}/${step}`).expect(200);
    }

    // B — cash booking.
    const b = await book({ scheduled_start: tomorrowAt('11:00') }, 'cash');
    await visit(b.id);

    // C — package bought by card, then one visit booked with it.
    const pkg = await api(admin.auth)
      .post('/admin/packages', {
        name_ar: 'باقة الغيار',
        service_id: world.wound,
        visits_count: 4,
        validity_days: 30,
        price: 100000,
      })
      .expect(201);
    const bought = await api(patient.auth)
      .post(`/packages/${pkg.body.data.id}/subscribe`, {
        patient_profile_id: patient.selfId,
        payment_method: 'card',
      })
      .expect(201);
    await webhook({
      payment_id: bought.body.data.payment_action.payment_id,
      transaction_id: 'tx-pkg',
      status: 'paid',
      amount: 100000,
    });
    const c = await book(
      { package_subscription_id: bought.body.data.subscription_id, scheduled_start: tomorrowAt('13:00') },
      'cash',
    );
    await visit(c.id);

    // Ledger before the payout.
    const ledger = await WalletLedgerModel.find({ ownerId: provider.id }).sort({ _id: 1 }).lean();
    expect(ledger.map((e) => [e.type, e.amount])).toEqual([
      ['credit', 24250],
      ['commission_due', -3750],
      ['commission_due', -3750],
      ['discount_reimbursement', 25000],
    ]);

    // Payout batch → approve → mark paid.
    await api(provider.auth)
      .put('/provider/payout-method', {
        type: 'bank',
        account_holder: 'منى حسن علي',
        bank_name: 'بنك مصر',
        account_number: 'EG380019000500000000263180002',
      })
      .expect(200);
    expect((await api(admin.auth).post('/admin/payouts/generate')).body.data).toEqual({
      created: 1,
      total: 41750,
    });
    const [payout] = (await api(admin.auth).get('/admin/payouts?status=pending')).body.data;
    await api(admin.auth)
      .post('/admin/payouts/bulk-approve', { payout_ids: [payout.id] })
      .expect(200);
    await api(admin.auth)
      .post(`/admin/payouts/${payout.id}/mark-paid`, { reference: 'TRX-EXIT' })
      .expect(200);
    const [mine] = (await api(provider.auth).get('/provider/payouts')).body.data;
    expect(mine).toMatchObject({
      status: 'paid',
      amount: 41750,
      statement: {
        card_earnings: 24250,
        commission_deducted: 7500,
        discounts_reimbursed: 25000,
        adjustments: 0,
        net: 41750,
      },
    });
    expect((await WalletBalanceModel.findOne({ ownerId: provider.id }).lean())!.balance).toBe(0);

    // Reconciliation: what came in through the gateway minus what went out = what the platform keeps.
    const paidIn = (await PaymentModel.find({ status: 'paid' }).lean()).reduce((t, p) => t + p.amount, 0);
    expect(paidIn).toBe(23000 + 100000);
    const bookings = await BookingModel.find({ _id: { $in: [a.id, b.id, c.id] } }).lean();
    const commission = bookings.reduce((t, x) => t + x.price.commissionAmount, 0);
    const promos = bookings.reduce((t, x) => t + (x.price.discounts?.promo ?? 0), 0);
    const packageHeld = 100000 - bookings.reduce((t, x) => t + (x.price.discounts?.package ?? 0), 0);
    expect(paidIn - mine.amount).toBe(commission - promos + packageHeld);
    expect(commission - promos).toBe(6250);
    expect(packageHeld).toBe(75000);
    expect((await api(patient.auth).get('/me/package-subscriptions')).body.data[0].visits_remaining).toBe(3);
  });
});
