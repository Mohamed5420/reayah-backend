import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import request from 'supertest';
import { Container } from 'typedi';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app';
import { useTestDatabase } from '../helpers/db';
import { createUserWithToken } from '../helpers/fixtures';
import { clearQueuedPushes, eventually, queuedPushes } from '../helpers/notifications';
import {
  createBookingWorld,
  tomorrowAt,
  type BookingWorld,
  type TestPatient,
  type TestProvider,
} from '../helpers/booking-world';
import { WalletLedgerModel } from '../../src/database/models/ledger/wallet.model';
import { withTransaction } from '../../src/database/transaction';
import { LedgerEntryType, LedgerOwnerType } from '../../src/interfaces/ILedger';
import { UserRole } from '../../src/interfaces/enums';
import { LedgerService } from '../../src/services/ledger/ledger.service';
import { SettingsService } from '../../src/services/settings';
import { registerCommissionAlerts } from '../../src/services/payouts/commission.service';
import { setGatewayForTests } from '../../src/services/payments/gateways';
import {
  FakeGateway,
  signFakeWebhook,
  type FakeWebhookBody,
} from '../../src/services/payments/gateways/fake.gateway';

/** Commission limit on cash bookings, paying commission in the app, payout statements. */

useTestDatabase();
const app = createTestApp();
registerCommissionAlerts();

let world: BookingWorld;
let patient: TestPatient;
let provider: TestProvider;
let admin: Awaited<ReturnType<typeof createUserWithToken>>;
let hour: number;

beforeEach(async () => {
  world = await createBookingWorld(app);
  patient = await world.newPatient();
  provider = await world.newProvider();
  admin = await createUserWithToken(UserRole.ADMIN);
  setGatewayForTests(new FakeGateway());
  clearQueuedPushes();
  hour = 9;
});

const as = (auth: string) => ({
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

const ledgerEntry = (type: LedgerEntryType, amount: number) =>
  withTransaction((session) =>
    Container.get(LedgerService).record(
      {
        ownerType: LedgerOwnerType.PROVIDER,
        ownerId: new mongoose.Types.ObjectId(provider.id),
        bookingId: null,
        type,
        amount,
        note: 'test',
      },
      session,
    ),
  );
/** Commission owed above the default 1,000 EGP limit. */
const putOverLimit = () => ledgerEntry(LedgerEntryType.COMMISSION_DUE, -150000);
const nextSlot = () => tomorrowAt(`${String(hour++).padStart(2, '0')}:00`);

describe('the commission limit', () => {
  it('over the limit: no new cash bookings (the quote says so), card still fine', async () => {
    await putOverLimit();
    const quote = await world.quote(patient, provider, { scheduled_start: nextSlot() });
    expect(quote.body.data.cash_available).toBe(false);
    const cash = await world.book(patient, provider, { scheduled_start: nextSlot() });
    expect(cash.status).toBe(409);
    expect(cash.body.error.message).toBe(
      'مقدم الخدمة لا يستقبل حجوزات نقدية حالياً، اختر الدفع بالبطاقة أو المحفظة',
    );

    await Container.get(SettingsService).update(
      { features: { video_consult: false, card_payment: true, packages: false } },
      { actorId: null },
    );
    const q = await world.quote(patient, provider, { scheduled_start: nextSlot() });
    const card = await request(app)
      .post('/api/v1/bookings')
      .set('Authorization', patient.auth)
      .set('Idempotency-Key', randomUUID())
      .send({ quote_token: q.body.data.quote_token, payment_method: 'card' });
    expect(card.status).toBe(201);

    const earnings = await as(provider.auth).get('/provider/earnings');
    expect(earnings.body.data.commission_limit).toEqual({ max: 100000, warning: true, over_limit: true });
    expect(earnings.body.data.commission_due).toBe(150000);
  });

  it('a provider who crossed the limit cannot accept a cash request they already had', async () => {
    const booked = await world.book(patient, provider, { scheduled_start: nextSlot() });
    await putOverLimit();
    const accept = await world.providerApi(provider, 'post', `/bookings/${booked.body.data.id}/accept`);
    expect(accept.status).toBe(409);
    expect(accept.body.error.message).toBe(
      'تجاوزت الحد المسموح للعمولة المستحقة، سدّدها لتستقبل حجوزات نقدية جديدة',
    );
  });

  it('warns at 80% and again when the limit is crossed — once each', async () => {
    // Limit 100 EGP → warning at 80 EGP; each visit adds 37.50 EGP commission (15% of 250).
    await Container.get(SettingsService).update({ max_commission_due: 10000 }, { actorId: null });
    await ledgerEntry(LedgerEntryType.COMMISSION_DUE, -5000);
    const complete = async () => {
      const booked = await world.book(patient, provider, { scheduled_start: nextSlot() });
      for (const step of ['accept', 'on-the-way', 'start', 'complete']) {
        await world.providerApi(provider, 'post', `/bookings/${booked.body.data.id}/${step}`).expect(200);
      }
    };
    const pushes = () =>
      queuedPushes().filter((p) => p.userId === provider.userId && p.data.type === 'payout');

    await complete(); // 50 → 87.50: crosses 80
    await eventually(() => expect(pushes().map((p) => p.title)).toEqual(['العمولة المستحقة تقترب من الحد']));
    await complete(); // 87.50 → 125: crosses 100
    await eventually(() =>
      expect(pushes().map((p) => p.title)).toEqual([
        'العمولة المستحقة تقترب من الحد',
        'توقف استقبال الحجوزات النقدية',
      ]),
    );
  });
});

describe('paying commission in the app', () => {
  const webhook = (body: FakeWebhookBody) =>
    request(app)
      .post('/api/v1/webhooks/payments/fake')
      .set('x-fake-signature', signFakeWebhook(body))
      .send(body);

  it('a signed payment credits the ledger once and lifts the limit', async () => {
    expect((await as(provider.auth).post('/provider/commission/pay', { method: 'card' })).status).toBe(409); // nothing owed
    await putOverLimit();
    expect(
      (await as(provider.auth).post('/provider/commission/pay', { method: 'card', amount: 200000 })).status,
    ).toBe(422);

    const checkout = await as(provider.auth).post('/provider/commission/pay', { method: 'wallet' });
    expect(checkout.status).toBe(201);
    expect(checkout.body.data).toMatchObject({
      amount: 150000,
      checkout_url: expect.stringContaining('fake-gateway'),
    });
    const paymentId: string = checkout.body.data.payment_id;

    const body: FakeWebhookBody = {
      payment_id: paymentId,
      transaction_id: 'tx-c1',
      status: 'paid',
      amount: 150000,
    };
    await webhook(body);
    await webhook(body); // repeat delivery
    const credits = await WalletLedgerModel.find({ ownerId: provider.id, type: 'commission_payment' }).lean();
    expect(credits.map((e) => e.amount)).toEqual([150000]);

    expect((await as(provider.auth).get(`/payments/${paymentId}`)).body.data).toMatchObject({
      status: 'paid',
      purpose: 'commission',
      booking_id: null,
    });
    expect((await as(provider.auth).get('/provider/earnings')).body.data.commission_limit.over_limit).toBe(
      false,
    );
    expect((await world.book(patient, provider, { scheduled_start: nextSlot() })).status).toBe(201);
    await eventually(() =>
      expect(queuedPushes().some((p) => p.userId === provider.userId && p.title === 'تم سداد العمولة')).toBe(
        true,
      ),
    );
  });
});

describe('admin and payouts', () => {
  it('commission dues list providers over the limit first, flagged', async () => {
    const small = await world.newProvider();
    await withTransaction((session) =>
      Container.get(LedgerService).record(
        {
          ownerType: LedgerOwnerType.PROVIDER,
          ownerId: new mongoose.Types.ObjectId(small.id),
          bookingId: null,
          type: LedgerEntryType.COMMISSION_DUE,
          amount: -3000,
          note: 'test',
        },
        session,
      ),
    );
    await putOverLimit();
    const dues = await as(admin.auth).get('/admin/commission-dues');
    expect(
      dues.body.data.map((d: { provider: { id: string }; over_limit: boolean }) => [
        d.provider.id,
        d.over_limit,
      ]),
    ).toEqual([
      [provider.id, true],
      [small.id, false],
    ]);
  });

  it('each payout carries a statement: card earnings − cash commission = net paid', async () => {
    await ledgerEntry(LedgerEntryType.CREDIT, 50000);
    await ledgerEntry(LedgerEntryType.COMMISSION_DUE, -3750);
    await ledgerEntry(LedgerEntryType.CREDIT, 20000);
    await as(provider.auth).put('/provider/payout-method', {
      type: 'wallet',
      account_holder: 'منى حسن',
      wallet_provider: 'vodafone_cash',
      account_number: '01001234567',
    });
    await as(admin.auth).post('/admin/payouts/generate');
    const [payout] = (await as(provider.auth).get('/provider/payouts')).body.data;
    expect(payout).toMatchObject({
      amount: 66250,
      statement: {
        card_earnings: 70000,
        commission_deducted: 3750,
        commission_paid: 0,
        other_deductions: 0,
        adjustments: 0,
        net: 66250,
      },
    });

    // The next statement starts after this payout.
    await ledgerEntry(LedgerEntryType.CREDIT, 30000);
    const ids = [(await as(admin.auth).get('/admin/payouts?status=pending')).body.data[0].id];
    await as(admin.auth).post('/admin/payouts/bulk-approve', { payout_ids: ids });
    await as(admin.auth).post(`/admin/payouts/${ids[0]}/mark-paid`, { reference: 'VF-1' });
    await as(admin.auth).post('/admin/payouts/generate');
    const latest = (await as(provider.auth).get('/provider/payouts')).body.data[0];
    expect(latest.statement).toMatchObject({ card_earnings: 30000, commission_deducted: 0, net: 30000 });
  });
});
