import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import request from 'supertest';
import { Container } from 'typedi';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app';
import { useTestDatabase } from '../helpers/db';
import { createUserWithToken } from '../helpers/fixtures';
import { clearQueuedPushes, eventually, queuedPushes } from '../helpers/notifications';
import { fakeBucket, sampleFiles, useFakeStorage } from '../helpers/storage';
import {
  createBookingWorld,
  tomorrowAt,
  type BookingWorld,
  type TestPatient,
  type TestProvider,
} from '../helpers/booking-world';
import { WalletLedgerModel } from '../../src/database/models/ledger/wallet.model';
import { PackageSubscriptionModel } from '../../src/database/models/marketing/marketing.models';
import { PaymentModel } from '../../src/database/models/payment/payment.models';
import { withTransaction } from '../../src/database/transaction';
import { LedgerEntryType, LedgerOwnerType } from '../../src/interfaces/ILedger';
import { LedgerService } from '../../src/services/ledger/ledger.service';
import { UserRole } from '../../src/interfaces/enums';
import { SettingsService } from '../../src/services/settings';
import { CreditService, PackageService, registerMarketingListeners } from '../../src/services/marketing';
import { PaymentService } from '../../src/services/payments/payment.service';
import { registerPaymentRefunds } from '../../src/services/payments/payment-refunds';
import { setGatewayForTests } from '../../src/services/payments/gateways';
import {
  FakeGateway,
  signFakeWebhook,
  type FakeWebhookBody,
} from '../../src/services/payments/gateways/fake.gateway';

/** M2.5: promo codes, packages, referrals and credit, home banners. */

useTestDatabase();
useFakeStorage();
const app = createTestApp();
registerMarketingListeners();
registerPaymentRefunds();

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

const api = (auth: string) => ({
  get: (path: string) => request(app).get(`/api/v1${path}`).set('Authorization', auth),
  post: (path: string, body?: object) =>
    request(app)
      .post(`/api/v1${path}`)
      .set('Authorization', auth)
      .set('Idempotency-Key', randomUUID())
      .send(body),
  patch: (path: string, body: object) =>
    request(app).patch(`/api/v1${path}`).set('Authorization', auth).send(body),
  delete: (path: string) => request(app).delete(`/api/v1${path}`).set('Authorization', auth),
});

const nextSlot = () => tomorrowAt(`${String(hour++).padStart(2, '0')}:00`);

const complete = async (bookingId: string, who = provider) => {
  for (const step of ['accept', 'on-the-way', 'start', 'complete']) {
    await world.providerApi(who, 'post', `/bookings/${bookingId}/${step}`).expect(200);
  }
};

const cancel = (who: TestPatient, bookingId: string) =>
  api(who.auth).post(`/bookings/${bookingId}/cancel`, { reason_code: 'changed_mind' });

const providerLedger = async (who = provider) =>
  (await WalletLedgerModel.find({ ownerId: who.id }).sort({ _id: 1 }).lean()).map((e) => [e.type, e.amount]);

const enableFeatures = () =>
  Container.get(SettingsService).update(
    { features: { video_consult: false, card_payment: true, packages: true } },
    { actorId: null },
  );

const webhook = (body: FakeWebhookBody) =>
  request(app)
    .post('/api/v1/webhooks/payments/fake')
    .set('x-fake-signature', signFakeWebhook(body))
    .send(body);

describe('promo codes', () => {
  const createPromo = (body: object) =>
    api(admin.auth).post('/admin/promo-codes', { type: 'percent', value: 20, max_discount: 10000, ...body });

  it('applies in the quote, counts per user, and the platform bears it on a cash visit', async () => {
    const created = await createPromo({ code: 'welcome20', description_ar: 'خصم 20% على أول حجز' });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ code: 'WELCOME20', uses_count: 0, per_user_limit: 1 });

    const check = await api(patient.auth).post('/promo-codes/validate', {
      code: 'welcome20',
      service_id: world.wound,
      subtotal: 25000,
    });
    expect(check.body.data).toEqual({ valid: true, discount: 5000, description: 'خصم 20% على أول حجز' });

    const quote = await world.quote(patient, provider, {
      promo_code: 'Welcome20',
      scheduled_start: nextSlot(),
    });
    expect(quote.body.data).toMatchObject({
      subtotal: 25000,
      travel_fee: 3000,
      discount: 5000,
      discounts: { promo: 5000, package: 0, credit: 0 },
      total: 23000,
      promo_code: 'WELCOME20',
    });
    expect(quote.body.data.lines).toContainEqual({ label: 'خصم WELCOME20', amount: -5000 });

    const booked = await world.book(patient, provider, {
      promo_code: 'WELCOME20',
      scheduled_start: nextSlot(),
    });
    expect(booked.status).toBe(201);
    // Used once: the per-user limit is reached.
    const again = await world.quote(patient, provider, {
      promo_code: 'WELCOME20',
      scheduled_start: nextSlot(),
    });
    expect(again.status).toBe(422);
    expect(again.body.error.code).toBe('PROMO_LIMIT_REACHED');

    await complete(booked.body.data.id);
    // Provider collected 230 EGP but earns 242.50 (250 − 37.50 commission + 30 travel): owed 12.50.
    expect(await providerLedger()).toEqual([
      ['commission_due', -3750],
      ['discount_reimbursement', 5000],
    ]);
    const detail = await api(patient.auth).get(`/bookings/${booked.body.data.id}`);
    expect(detail.body.data).toMatchObject({
      promo_code: 'WELCOME20',
      price: { discount: 5000, total: 23000 },
    });
    expect((await api(admin.auth).get('/admin/promo-codes')).body.data[0].uses_count).toBe(1);
  });

  it('a cancelled booking gives the use back', async () => {
    await createPromo({ code: 'ONCE', max_uses: 1 });
    const booked = await world.book(patient, provider, { promo_code: 'ONCE', scheduled_start: nextSlot() });
    const other = await world.newPatient();
    expect(
      (await world.quote(other, provider, { promo_code: 'ONCE', scheduled_start: nextSlot() })).status,
    ).toBe(422);
    expect((await cancel(patient, booked.body.data.id)).status).toBe(200);
    expect((await api(admin.auth).get('/admin/promo-codes')).body.data[0].uses_count).toBe(0);
    expect(
      (await world.book(other, provider, { promo_code: 'ONCE', scheduled_start: nextSlot() })).status,
    ).toBe(201);
  });

  it('expired, unknown, wrong service, first booking only', async () => {
    await createPromo({ code: 'OLD', valid_to: new Date(Date.now() - 60_000).toISOString() });
    await createPromo({ code: 'OTHER', service_ids: [new mongoose.Types.ObjectId().toString()] });
    await createPromo({ code: 'FIRST', first_booking_only: true });
    const validate = (code: string) =>
      api(patient.auth).post('/promo-codes/validate', { code, service_id: world.wound, subtotal: 25000 });

    expect((await validate('OLD')).body.error.code).toBe('PROMO_EXPIRED');
    expect((await validate('NOPE')).body.error.code).toBe('PROMO_INVALID');
    const other = await validate('OTHER');
    expect(other.body.error).toMatchObject({
      code: 'PROMO_INVALID',
      message: 'كود الخصم لا ينطبق على هذه الخدمة',
    });
    expect((await validate('FIRST')).status).toBe(200);
    await world.book(patient, provider, { scheduled_start: nextSlot() });
    expect((await validate('FIRST')).body.error.message).toBe('كود الخصم متاح لأول حجز فقط');

    expect((await createPromo({ code: 'BIG', value: 150 })).status).toBe(422);
    expect((await createPromo({ code: 'OLD' })).status).toBe(409); // duplicate
    expect((await api(patient.auth).get('/admin/promo-codes')).status).toBe(403);
  });
});

describe('packages', () => {
  const createPackage = async () => {
    const res = await api(admin.auth).post('/admin/packages', {
      name_ar: 'باقة الغيار',
      service_id: world.wound,
      visits_count: 4,
      validity_days: 30,
      price: 100000,
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ per_visit_value: 25000, sold_count: 0 });
    return res.body.data.id as string;
  };

  /** Buys the package for the patient's own profile and confirms the payment. */
  const buy = async (packageId: string, who = patient) => {
    const res = await api(who.auth).post(`/packages/${packageId}/subscribe`, {
      patient_profile_id: who.selfId,
      payment_method: 'card',
    });
    expect(res.status).toBe(201);
    expect(res.body.data.travel_fee_note).toBe(
      'سعر الباقة لا يشمل رسوم الانتقال، وتُدفع مع كل زيارة حسب منطقتك ومقدم الخدمة',
    );
    const paymentId: string = res.body.data.payment_action.payment_id;
    return { subscriptionId: res.body.data.subscription_id as string, paymentId };
  };
  const pay = (paymentId: string, tx = randomUUID()) =>
    webhook({ payment_id: paymentId, transaction_id: tx, status: 'paid', amount: 100000 });

  it('listing: only packages someone in the area can serve at the per-visit value; search filters providers', async () => {
    await enableFeatures();
    const packageId = await createPackage();
    const expensive = await world.newProvider({ services: [{ serviceId: world.wound, price: 30000 }] });

    expect((await api(patient.auth).get(`/packages?area_id=${world.nasrCity}`)).body.data).toMatchObject([
      {
        id: packageId,
        name: 'باقة الغيار',
        visits_count: 4,
        price: 100000,
        per_visit_value: 25000,
        travel_fee_included: false,
        travel_fee_note: 'سعر الباقة لا يشمل رسوم الانتقال، وتُدفع مع كل زيارة حسب منطقتك ومقدم الخدمة',
      },
    ]);
    expect((await api(patient.auth).get(`/packages?area_id=${world.maadi}`)).body.data).toEqual([]);

    const search = await api(patient.auth).get(
      `/providers?service_id=${world.wound}&area_id=${world.nasrCity}&package_id=${packageId}`,
    );
    expect(search.body.data.map((p: { id: string }) => p.id)).toEqual([provider.id]);
    expect(search.body.data.map((p: { id: string }) => p.id)).not.toContain(expensive.id);

    await Container.get(SettingsService).update(
      { features: { video_consult: false, card_payment: true, packages: false } },
      { actorId: null },
    );
    expect((await api(patient.auth).get('/packages')).body.data).toEqual([]);
  });

  it('buy → paid → book visits: covered subtotal, visit held, given back on cancel, used on completion', async () => {
    await enableFeatures();
    const packageId = await createPackage();
    const { subscriptionId, paymentId } = await buy(packageId);
    let mine = (await api(patient.auth).get('/me/package-subscriptions')).body.data;
    expect(mine[0]).toMatchObject({ id: subscriptionId, status: 'pending_payment', payment_id: null });

    await pay(paymentId);
    await pay(paymentId); // repeat delivery: no change
    mine = (await api(patient.auth).get('/me/package-subscriptions')).body.data;
    expect(mine[0]).toMatchObject({
      status: 'active',
      visits_total: 4,
      visits_remaining: 4,
      visits_booked: 0,
    });
    await eventually(() =>
      expect(queuedPushes().some((p) => p.userId === patient.userId && p.title === 'تم تفعيل الباقة')).toBe(
        true,
      ),
    );

    const expensive = await world.newProvider({ services: [{ serviceId: world.wound, price: 30000 }] });
    const tooPricey = await world.quote(patient, expensive, {
      package_subscription_id: subscriptionId,
      scheduled_start: nextSlot(),
    });
    expect(tooPricey.status).toBe(422);
    expect(tooPricey.body.error.fields.provider_id).toEqual([
      'سعر مقدم الخدمة أعلى من قيمة الزيارة في الباقة',
    ]);
    expect(
      (
        await world.quote(patient, provider, {
          package_subscription_id: subscriptionId,
          promo_code: 'X',
          scheduled_start: nextSlot(),
        })
      ).body.error.fields.promo_code,
    ).toBeDefined();

    const quote = await world.quote(patient, provider, {
      package_subscription_id: subscriptionId,
      scheduled_start: nextSlot(),
    });
    expect(quote.body.data).toMatchObject({
      subtotal: 25000,
      discounts: { promo: 0, package: 25000, credit: 0 },
      total: 3000, // the travel fee
      package_subscription_id: subscriptionId,
    });
    expect(quote.body.data.lines).toContainEqual({ label: 'مغطاة بالباقة (باقة الغيار)', amount: -25000 });

    const first = await world.book(patient, provider, {
      package_subscription_id: subscriptionId,
      scheduled_start: nextSlot(),
    });
    expect(first.status).toBe(201);
    expect((await api(patient.auth).get('/me/package-subscriptions')).body.data[0].visits_booked).toBe(1);
    await cancel(patient, first.body.data.id);
    expect((await api(patient.auth).get('/me/package-subscriptions')).body.data[0].visits_booked).toBe(0);

    const second = await world.book(patient, provider, {
      package_subscription_id: subscriptionId,
      scheduled_start: nextSlot(),
    });
    await complete(second.body.data.id);
    expect((await api(patient.auth).get('/me/package-subscriptions')).body.data[0]).toMatchObject({
      visits_remaining: 3,
      visits_booked: 0,
    });
    // Collected only the 30 EGP travel fee; earns 250 − 37.50 + 30 → the platform owes 212.50.
    expect(await providerLedger()).toEqual([
      ['commission_due', -3750],
      ['discount_reimbursement', 25000],
    ]);
    const home = await api(patient.auth).get('/home');
    expect(home.body.data.active_package).toMatchObject({
      id: subscriptionId,
      name: 'باقة الغيار',
      visits_remaining: 3,
    });
    expect((await api(admin.auth).get('/admin/packages')).body.data[0].sold_count).toBe(1);
  });

  it('no visits left and another profile are refused', async () => {
    await enableFeatures();
    const packageId = await createPackage();
    const { subscriptionId, paymentId } = await buy(packageId);
    await pay(paymentId);
    await PackageSubscriptionModel.updateOne({ _id: subscriptionId }, { visitsRemaining: 1 });
    await world.book(patient, provider, {
      package_subscription_id: subscriptionId,
      scheduled_start: nextSlot(),
    });
    const full = await world.quote(patient, provider, {
      package_subscription_id: subscriptionId,
      scheduled_start: nextSlot(),
    });
    expect(full.body.error.code).toBe('PACKAGE_NO_VISITS_LEFT');

    const other = await world.newPatient();
    const foreign = await world.quote(other, provider, {
      package_subscription_id: subscriptionId,
      scheduled_start: nextSlot(),
    });
    expect(foreign.status).toBe(404);
  });

  it('unpaid purchases are cancelled by the sweep; paying after that is refunded', async () => {
    await enableFeatures();
    const packageId = await createPackage();
    const { subscriptionId, paymentId } = await buy(packageId);
    await PackageSubscriptionModel.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(subscriptionId) },
      { $set: { createdAt: new Date(Date.now() - 60 * 60_000) } },
    );
    await Container.get(PaymentService).expireUnpaid();
    expect((await PackageSubscriptionModel.findById(subscriptionId).lean())!.status).toBe('cancelled');
    expect((await api(patient.auth).get('/me/package-subscriptions')).body.data).toEqual([]);

    await pay(paymentId);
    const payment = await PaymentModel.findById(paymentId).lean();
    expect(payment).toMatchObject({ status: 'refunded', refundedAmount: 100000 });
    expect((await PackageSubscriptionModel.findById(subscriptionId).lean())!.status).toBe('cancelled');
  });

  it('expiry job: notice before the end, one visit left, then expired', async () => {
    await enableFeatures();
    const packageId = await createPackage();
    const { subscriptionId, paymentId } = await buy(packageId);
    await pay(paymentId);
    clearQueuedPushes();
    const titles = () =>
      queuedPushes()
        .filter((p) => p.userId === patient.userId)
        .map((p) => p.title);

    await PackageSubscriptionModel.updateOne(
      { _id: subscriptionId },
      { expiresAt: new Date(Date.now() + 24 * 3600_000), visitsRemaining: 1 },
    );
    await Container.get(PackageService).processDue();
    await Container.get(PackageService).processDue(); // once each
    await eventually(() => expect(titles().sort()).toEqual(['باقتك على وشك الانتهاء', 'متبقي زيارة واحدة']));

    await PackageSubscriptionModel.updateOne(
      { _id: subscriptionId },
      { expiresAt: new Date(Date.now() - 1000) },
    );
    await Container.get(PackageService).processDue();
    expect((await PackageSubscriptionModel.findById(subscriptionId).lean())!.status).toBe('expired');
    await eventually(() => expect(titles()).toContain('انتهت الباقة'));
    const quote = await world.quote(patient, provider, {
      package_subscription_id: subscriptionId,
      scheduled_start: nextSlot(),
    });
    expect(quote.body.error.code).toBe('PACKAGE_EXPIRED');
  });

  it('cash is not offered for packages', async () => {
    await enableFeatures();
    const packageId = await createPackage();
    const res = await api(patient.auth).post(`/packages/${packageId}/subscribe`, {
      patient_profile_id: patient.selfId,
      payment_method: 'cash',
    });
    expect(res.status).toBe(422);
  });
});

describe('referrals and credit', () => {
  const creditOf = async (who: TestPatient) =>
    (await api(who.auth).get('/me/referral')).body.data.credit_balance as number;

  it('both sides get 50 EGP after the invited patient’s first completed visit; credit is used automatically', async () => {
    const mine = await api(patient.auth).get('/me/referral');
    expect(mine.body.data).toMatchObject({ invited_count: 0, rewards_earned: 0, credit_balance: 0 });
    const code: string = mine.body.data.code;
    expect(mine.body.data.share_url).toBe(`https://reaya.app/r/${code}`);
    expect((await api(patient.auth).get('/me/referral')).body.data.code).toBe(code); // stable

    const friend = await world.newPatient(undefined, { referral_code: code.toLowerCase() });
    expect((await api(patient.auth).get('/me/referral')).body.data.invited_count).toBe(1);
    // A reward is an account notification: pushed even with promotions turned off.
    for (const who of [patient, friend]) {
      await request(app)
        .put('/api/v1/me/notification-settings')
        .set('Authorization', who.auth)
        .send({ reminders: true, promotions: false, chat: true })
        .expect(200);
    }

    const visit = await world.book(friend, provider, { scheduled_start: nextSlot() });
    await complete(visit.body.data.id);
    await eventually(async () => expect(await creditOf(friend)).toBe(5000));
    expect(await creditOf(patient)).toBe(5000);
    expect((await api(patient.auth).get('/me/referral')).body.data.rewards_earned).toBe(5000);
    await eventually(() =>
      expect(queuedPushes().some((p) => p.userId === patient.userId && p.title === 'مكافأة دعوة صديق')).toBe(
        true,
      ),
    );
    await eventually(() =>
      expect(queuedPushes().some((p) => p.userId === friend.userId && p.title === 'حصلت على رصيد')).toBe(
        true,
      ),
    );

    // A second completed visit doesn't pay again.
    const quote = await world.quote(friend, provider, { scheduled_start: nextSlot() });
    expect(quote.body.data).toMatchObject({ discounts: { credit: 5000 }, total: 23000 });
    expect(quote.body.data.lines).toContainEqual({ label: 'رصيد الدعوات', amount: -5000 });
    const next = await world.book(friend, provider, { scheduled_start: nextSlot() });
    expect(await creditOf(friend)).toBe(0);
    await cancel(friend, next.body.data.id);
    expect(await creditOf(friend)).toBe(5000); // given back
    const third = await world.book(friend, provider, { scheduled_start: nextSlot() });
    await complete(third.body.data.id);
    expect(await creditOf(patient)).toBe(5000);
  });

  it('a provider who invites a patient is rewarded on their earnings', async () => {
    const code: string = (await api(provider.auth).get('/me/referral')).body.data.code;
    const invited = await world.newPatient(undefined, { referral_code: code });
    const visit = await world.book(invited, provider, { scheduled_start: nextSlot() });
    await complete(visit.body.data.id);
    await eventually(async () => expect(await providerLedger()).toContainEqual(['referral_reward', 5000]));
  });

  it('an unknown code at sign-up is ignored', async () => {
    const someone = await world.newPatient(undefined, { referral_code: 'NOSUCH1' });
    expect((await api(someone.auth).get('/me/referral')).status).toBe(200);
  });

  it('credit covering everything: payment method "covered", not cash; the provider is paid in full', async () => {
    await withTransaction((session) =>
      Container.get(CreditService).grant(new mongoose.Types.ObjectId(patient.userId), 60000, 'test', session),
    );
    // Over the cash commission limit: doesn't matter, nothing is collected.
    await Container.get(SettingsService).update({ max_commission_due: 0 }, { actorId: null });
    await withTransaction((session) =>
      Container.get(LedgerService).record(
        {
          ownerType: LedgerOwnerType.PROVIDER,
          ownerId: new mongoose.Types.ObjectId(provider.id),
          bookingId: null,
          type: LedgerEntryType.COMMISSION_DUE,
          amount: -1000,
          note: 'test',
        },
        session,
      ),
    );
    const q = await world.quote(patient, provider, { scheduled_start: nextSlot() });
    expect(q.body.data).toMatchObject({ total: 0, discounts: { credit: 28000 }, payment_required: false });
    const bookCovered = (quoteToken: string) =>
      request(app)
        .post('/api/v1/bookings')
        .set('Authorization', patient.auth)
        .set('Idempotency-Key', randomUUID())
        .send({ quote_token: quoteToken, payment_method: 'cash' });
    const booked = await bookCovered(q.body.data.quote_token);
    expect(booked.status).toBe(201);
    expect(booked.body.data).toMatchObject({
      payment_method: 'covered',
      payment_status: 'paid',
      payment_action: null,
    });
    expect(await creditOf(patient)).toBe(32000);
    // The client can't pick "covered" itself.
    const paid = await world.quote(patient, provider, { scheduled_start: nextSlot() });
    expect(
      (
        await request(app)
          .post('/api/v1/bookings')
          .set('Authorization', patient.auth)
          .set('Idempotency-Key', randomUUID())
          .send({ quote_token: paid.body.data.quote_token, payment_method: 'covered' })
      ).status,
    ).toBe(422);

    await complete(booked.body.data.id);
    // Collected nothing; credited 250 − 37.50 + 30 = 242.50, like a card booking.
    expect(await providerLedger()).toEqual([
      ['commission_due', -1000],
      ['credit', 24250],
    ]);

    // Cancelling a covered booking gives the credit back; there is no gateway refund.
    const second = await bookCovered(
      (await world.quote(patient, provider, { scheduled_start: nextSlot() })).body.data.quote_token,
    );
    expect(await creditOf(patient)).toBe(4000);
    await cancel(patient, second.body.data.id);
    expect(await creditOf(patient)).toBe(32000);
    expect(await PaymentModel.countDocuments()).toBe(0);
  });
});

describe('home banners', () => {
  const upload = async () => {
    const res = await request(app)
      .post('/api/v1/uploads')
      .set('Authorization', admin.auth)
      .field('purpose', 'banner')
      .attach('file', sampleFiles.png, 'banner.png');
    expect(res.status).toBe(201);
    return res.body.data.file_key as string;
  };

  it('admin creates, schedules and deletes banners; /home shows the live ones', async () => {
    const created = await api(admin.auth).post('/admin/banners', {
      image_key: await upload(),
      title_ar: 'خصم الشتاء',
      action: 'promo',
      value: 'WELCOME20',
    });
    expect(created.status).toBe(201);
    expect([...fakeBucket.keys()].some((k) => k.startsWith('banners/'))).toBe(true);
    await api(admin.auth).post('/admin/banners', {
      image_key: await upload(),
      action: 'none',
      ends_at: new Date(Date.now() - 1000).toISOString(),
      starts_at: new Date(Date.now() - 86_400_000).toISOString(),
    });

    const home = await api(patient.auth).get('/home');
    expect(home.body.data.banners).toEqual([
      {
        id: created.body.data.id,
        title: 'خصم الشتاء',
        image_url: expect.stringContaining('banners/'),
        action: 'promo',
        value: 'WELCOME20',
      },
    ]);
    expect(home.body.data.active_package).toBeNull();

    const bad = await api(admin.auth).post('/admin/banners', {
      image_key: await upload(),
      action: 'url',
      value: 'http://insecure.example.com',
    });
    expect(bad.body.error.fields.value).toBeDefined();
    // Someone else's upload can't be attached.
    const theirs = await request(app)
      .post('/api/v1/uploads')
      .set('Authorization', patient.auth)
      .field('purpose', 'banner')
      .attach('file', sampleFiles.png, 'x.png');
    expect(
      (await api(admin.auth).post('/admin/banners', { image_key: theirs.body.data.file_key })).status,
    ).toBe(404);

    expect((await api(admin.auth).delete(`/admin/banners/${created.body.data.id}`)).status).toBe(204);
    expect((await api(patient.auth).get('/home')).body.data.banners).toEqual([]);
  });
});
