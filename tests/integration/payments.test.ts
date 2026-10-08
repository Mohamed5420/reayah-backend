import request from 'supertest';
import { Container } from 'typedi';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app';
import { useTestDatabase } from '../helpers/db';
import { createUserWithToken } from '../helpers/fixtures';
import { clearQueuedPushes, eventually, queuedPushes } from '../helpers/notifications';
import { registerBookingNotifications } from '../../src/services/notification/booking-notifications';
import {
  createBookingWorld,
  tomorrowAt,
  type BookingWorld,
  type TestPatient,
  type TestProvider,
} from '../helpers/booking-world';
import { BookingModel } from '../../src/database/models/booking/booking.model';
import { PaymentModel, RefundModel } from '../../src/database/models/payment/payment.models';
import { WalletLedgerModel } from '../../src/database/models/ledger/wallet.model';
import { AuditLogModel } from '../../src/database/models/audit-log/audit-log.model';
import { UserRole } from '../../src/interfaces/enums';
import { SettingsService } from '../../src/services/settings';
import { PaymentService } from '../../src/services/payments/payment.service';
import { registerPaymentRefunds } from '../../src/services/payments/payment-refunds';
import { setGatewayForTests } from '../../src/services/payments/gateways';
import {
  FakeGateway,
  signFakeWebhook,
  type FakeWebhookBody,
} from '../../src/services/payments/gateways/fake.gateway';

/** M2.3: card / wallet payments through the gateway interface (fake gateway in tests). */

useTestDatabase();
const app = createTestApp();
registerPaymentRefunds();

let world: BookingWorld;
let patient: TestPatient;
let provider: TestProvider;
let gateway: FakeGateway;
let nextHour: number;

const as = (auth: string) => ({
  get: (path: string) => request(app).get(`/api/v1${path}`).set('Authorization', auth),
  post: (path: string, body?: object) =>
    request(app).post(`/api/v1${path}`).set('Authorization', auth).send(body),
});

const enableCards = () =>
  Container.get(SettingsService).update(
    { features: { video_consult: false, card_payment: true, packages: false } },
    { actorId: null },
  );

/** Books with card/wallet through the real endpoints. */
const bookWith = async (method: 'card' | 'wallet') => {
  const q = await world.quote(patient, provider, {
    scheduled_start: tomorrowAt(`${String(nextHour++).padStart(2, '0')}:00`),
  });
  return request(app)
    .post('/api/v1/bookings')
    .set('Authorization', patient.auth)
    .set('Idempotency-Key', crypto.randomUUID())
    .send({ quote_token: q.body.data.quote_token, payment_method: method });
};

const webhook = (body: FakeWebhookBody, signature = signFakeWebhook(body)) =>
  request(app).post('/api/v1/webhooks/payments/fake').set('x-fake-signature', signature).send(body);

beforeEach(async () => {
  world = await createBookingWorld(app);
  patient = await world.newPatient();
  provider = await world.newProvider();
  gateway = new FakeGateway();
  setGatewayForTests(gateway);
  nextHour = 9;
});

describe('paying for a booking', () => {
  it('card bookings need the card_payment flag', async () => {
    const res = await bookWith('card');
    expect(res.status).toBe(422);
    expect(Object.keys(res.body.error.fields)).toEqual(['payment_method']);
  });

  it('a card booking returns a checkout; the signed webhook marks it paid (once)', async () => {
    await enableCards();
    const created = await bookWith('card');
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      payment_method: 'card',
      payment_status: 'unpaid',
      payment_action: {
        checkout_url: expect.stringContaining('fake-gateway'),
        payment_id: expect.any(String),
      },
    });
    const paymentId: string = created.body.data.payment_action.payment_id;
    const bookingId: string = created.body.data.id;
    expect((await as(patient.auth).get(`/payments/${paymentId}`)).body.data).toMatchObject({
      status: 'pending',
      amount: (await BookingModel.findById(bookingId).lean())!.price.total,
    });

    // A forged callback changes nothing.
    const total = (await BookingModel.findById(bookingId).lean())!.price.total;
    const body: FakeWebhookBody = {
      payment_id: paymentId,
      transaction_id: 'tx-1',
      status: 'paid',
      amount: total,
    };
    expect((await webhook(body, 'forged')).status).toBe(400);
    expect((await PaymentModel.findById(paymentId).lean())!.status).toBe('pending');

    expect((await webhook(body)).status).toBe(200);
    expect((await webhook(body)).status).toBe(200); // repeat delivery: no-op
    const payment = await as(patient.auth).get(`/payments/${paymentId}`);
    expect(payment.body.data).toMatchObject({
      status: 'paid',
      instrument: { brand: 'Visa', last4: '4242' },
      checkout_url: null,
    });
    expect((await BookingModel.findById(bookingId).lean())!.paymentStatus).toBe('paid');
    expect((await as(patient.auth).get('/me/payments')).body.meta.total).toBe(1);

    // Someone else's payment is invisible.
    const stranger = await world.newPatient();
    expect((await as(stranger.auth).get(`/payments/${paymentId}`)).status).toBe(404);
  });

  it('rejects a paid amount that does not match', async () => {
    await enableCards();
    const created = await bookWith('wallet');
    const paymentId = created.body.data.payment_action.payment_id;
    await webhook({ payment_id: paymentId, transaction_id: 'tx-9', status: 'paid', amount: 100 });
    expect(await PaymentModel.findById(paymentId).lean()).toMatchObject({
      status: 'failed',
      failureReason: 'amount_mismatch',
    });
    expect((await BookingModel.findById(created.body.data.id).lean())!.paymentStatus).toBe('failed');

    // The patient retries with a fresh checkout.
    const retry = await as(patient.auth).post('/payments/initiate', {
      purpose: 'booking',
      reference_id: created.body.data.id,
    });
    expect(retry.status).toBe(422); // Idempotency-Key is required
    const again = await request(app)
      .post('/api/v1/payments/initiate')
      .set('Authorization', patient.auth)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ purpose: 'booking', reference_id: created.body.data.id, method: 'card' });
    expect(again.status).toBe(200);
    expect(again.body.data.payment_id).not.toBe(paymentId);
    expect((await BookingModel.findById(created.body.data.id).lean())!.paymentMethod).toBe('card');
  });

  it('the return URL sends the browser back into the app', async () => {
    const res = await request(app).get('/api/v1/payments/665f1c2b9e1d2a4c3b9e8f1a/return');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('reaya://payment-result?payment_id=665f1c2b9e1d2a4c3b9e8f1a');
  });
});

/** A card booking paid through the webhook. */
const paidBooking = async () => {
  await enableCards();
  const created = await bookWith('card');
  const bookingId: string = created.body.data.id;
  const total = (await BookingModel.findById(bookingId).lean())!.price.total;
  await webhook({
    payment_id: created.body.data.payment_action.payment_id,
    transaction_id: `tx-${bookingId}`,
    status: 'paid',
    amount: total,
  });
  return { bookingId, total, paymentId: created.body.data.payment_action.payment_id as string };
};

describe('money after payment', () => {
  it('completion credits the provider their share', async () => {
    const { bookingId } = await paidBooking();
    for (const step of ['accept', 'on-the-way', 'start', 'complete']) {
      await world.providerApi(provider, 'post', `/bookings/${bookingId}/${step}`);
    }
    const booking = await BookingModel.findById(bookingId).lean();
    const entries = await WalletLedgerModel.find({ bookingId }).lean();
    expect(entries).toEqual([
      expect.objectContaining({ type: 'credit', amount: booking!.price.providerPayout }),
    ]);
  });

  it('cancelling a paid booking refunds it in full, automatically', async () => {
    const { bookingId, total, paymentId } = await paidBooking();
    const cancel = await as(patient.auth).post(`/bookings/${bookingId}/cancel`, {
      reason_code: 'changed_mind',
    });
    expect(cancel.body.data).toMatchObject({ status: 'cancelled', refund_amount: total });
    await eventually(async () =>
      expect((await PaymentModel.findById(paymentId).lean())!.status).toBe('refunded'),
    );
    expect(gateway.refunds).toEqual([{ transactionId: `tx-${bookingId}`, amount: total }]);
    expect((await BookingModel.findById(bookingId).lean())!.paymentStatus).toBe('refunded');
    expect(await RefundModel.countDocuments({ bookingId, status: 'succeeded' })).toBe(1);
  });

  it('admins can refund part of a payment, never more than was paid', async () => {
    const admin = await createUserWithToken(UserRole.ADMIN);
    const { bookingId, total, paymentId } = await paidBooking();
    const part = await as(admin.auth).post(`/admin/bookings/${bookingId}/refund`, {
      amount: 5000,
      reason: 'تأخير الممرضة',
    });
    expect(part.status).toBe(201);
    expect(part.body.data).toMatchObject({ amount: 5000, status: 'succeeded' });
    expect(await PaymentModel.findById(paymentId).lean()).toMatchObject({
      status: 'partially_refunded',
      refundedAmount: 5000,
    });
    expect(
      (
        await as(admin.auth).post(`/admin/bookings/${bookingId}/refund`, {
          amount: total,
          reason: 'كل المبلغ',
        })
      ).status,
    ).toBe(422);
    expect(await AuditLogModel.exists({ action: 'booking.refund', entityId: bookingId })).toBeTruthy();
    expect((await as(admin.auth).get('/admin/payments?status=partially_refunded')).body.meta.total).toBe(1);
    expect(
      (await as(patient.auth).post(`/admin/bookings/${bookingId}/refund`, { reason: 'x'.repeat(5) })).status,
    ).toBe(403);
  });
});

describe('the payment window', () => {
  it('an unpaid card booking expires after the window, and a payment that lands afterwards is refunded', async () => {
    await enableCards();
    const created = await bookWith('card');
    const bookingId: string = created.body.data.id;
    const paymentId: string = created.body.data.payment_action.payment_id;
    await BookingModel.collection.updateOne(
      { _id: (await BookingModel.findById(bookingId).lean())!._id },
      { $set: { createdAt: new Date(Date.now() - 16 * 60_000) } },
    );
    expect(await Container.get(PaymentService).expireUnpaid()).toBe(1);
    const booking = await BookingModel.findById(bookingId).lean();
    expect(booking!.status).toBe('expired');
    expect((await PaymentModel.findById(paymentId).lean())!.status).toBe('expired');

    await webhook({
      payment_id: paymentId,
      transaction_id: 'tx-late',
      status: 'paid',
      amount: booking!.price.total,
    });
    expect((await PaymentModel.findById(paymentId).lean())!.status).toBe('refunded');
    expect(gateway.refunds).toEqual([{ transactionId: 'tx-late', amount: booking!.price.total }]);
  });
});

describe('awaiting payment (card / wallet bookings reach the provider only once paid)', () => {
  it('stays invisible to the provider until the payment lands, then becomes a normal request', async () => {
    registerBookingNotifications();
    await enableCards();
    clearQueuedPushes();
    const created = await bookWith('card');
    expect(created.body.data.status).toBe('awaiting_payment');
    const bookingId: string = created.body.data.id;

    expect((await world.providerApi(provider, 'get', `/bookings/${bookingId}`)).status).toBe(404);
    expect((await world.providerApi(provider, 'get', '/bookings')).body.meta.total).toBe(0);
    expect((await BookingModel.findById(bookingId).lean())!.assignmentDeadline).toBeNull();
    expect(queuedPushes().filter((p) => p.userId === provider.userId)).toEqual([]);

    const total = (await BookingModel.findById(bookingId).lean())!.price.total;
    await webhook({
      payment_id: created.body.data.payment_action.payment_id,
      transaction_id: 'tx-a',
      status: 'paid',
      amount: total,
    });
    const booking = await BookingModel.findById(bookingId).lean();
    expect(booking).toMatchObject({ status: 'pending', paymentStatus: 'paid' });
    expect(booking!.assignmentDeadline!.getTime()).toBeGreaterThan(Date.now());
    expect((await world.providerApi(provider, 'get', `/bookings/${bookingId}`)).status).toBe(200);
    await eventually(() =>
      expect(
        queuedPushes().some((p) => p.userId === provider.userId && p.data.type === 'booking_request'),
      ).toBe(true),
    );
  });

  it('holds the slot while unpaid; cancelling then is free and never reaches the provider', async () => {
    registerBookingNotifications();
    await enableCards();
    const created = await bookWith('card');
    const slot = (await BookingModel.findById(created.body.data.id).lean())!.scheduledStart.toISOString();
    const other = await world.newPatient();
    expect((await world.book(other, provider, { scheduled_start: slot })).status).toBe(409);

    clearQueuedPushes();
    const cancel = await as(patient.auth).post(`/bookings/${created.body.data.id}/cancel`, {
      reason_code: 'changed_mind',
    });
    expect(cancel.body.data).toEqual({ status: 'cancelled', cancellation_fee: 0, refund_amount: 0 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(queuedPushes().filter((p) => p.userId === provider.userId)).toEqual([]);
  });
});

describe('travel-fee charges', () => {
  it('cancelling a paid booking after "on the way" refunds all but the travel fee, which goes to the provider', async () => {
    const { bookingId, total, paymentId } = await paidBooking();
    await world.providerApi(provider, 'post', `/bookings/${bookingId}/accept`);
    await world.providerApi(provider, 'post', `/bookings/${bookingId}/on-the-way`);
    const fee = (await BookingModel.findById(bookingId).lean())!.price.travelFee;
    expect(fee).toBeGreaterThan(0);

    const cancel = await as(patient.auth).post(`/bookings/${bookingId}/cancel`, {
      reason_code: 'changed_mind',
    });
    expect(cancel.body.data).toEqual({
      status: 'cancelled',
      cancellation_fee: fee,
      refund_amount: total - fee,
    });
    await eventually(async () =>
      expect(gateway.refunds).toEqual([{ transactionId: `tx-${bookingId}`, amount: total - fee }]),
    );
    await eventually(async () =>
      expect(await WalletLedgerModel.find({ bookingId }).lean()).toEqual([
        expect.objectContaining({ type: 'credit', amount: fee }),
      ]),
    );
    expect((await PaymentModel.findById(paymentId).lean())!.status).toBe('partially_refunded');
  });

  it('a no-show on a paid booking refunds all but the travel fee; with the setting off, everything', async () => {
    const { bookingId, total } = await paidBooking();
    await world.providerApi(provider, 'post', `/bookings/${bookingId}/accept`);
    await BookingModel.updateOne({ _id: bookingId }, { scheduledStart: new Date(Date.now() - 60_000) });
    await world.providerApi(provider, 'post', `/bookings/${bookingId}/no-show`).expect(200);
    const fee = (await BookingModel.findById(bookingId).lean())!.price.travelFee;
    await eventually(async () =>
      expect(gateway.refunds).toEqual([{ transactionId: `tx-${bookingId}`, amount: total - fee }]),
    );

    await Container.get(SettingsService).update({ travel_fee_on_no_show: false }, { actorId: null });
    const second = await paidBooking();
    await world.providerApi(provider, 'post', `/bookings/${second.bookingId}/accept`);
    await BookingModel.updateOne(
      { _id: second.bookingId },
      { scheduledStart: new Date(Date.now() - 60_000) },
    );
    await world.providerApi(provider, 'post', `/bookings/${second.bookingId}/no-show`).expect(200);
    await eventually(async () =>
      expect(gateway.refunds).toContainEqual({
        transactionId: `tx-${second.bookingId}`,
        amount: second.total,
      }),
    );
    expect((await BookingModel.findById(second.bookingId).lean())!.patientFee).toBeNull();
  });

  it('cash charges are not collected but show up for admins per patient, next to late cancellations', async () => {
    const admin = await createUserWithToken(UserRole.ADMIN);
    // A free late cancellation: accepted, an hour before the visit, provider not on the way yet.
    const lateOne = await world.book(patient, provider, { scheduled_start: tomorrowAt('11:00') });
    await world.providerApi(provider, 'post', `/bookings/${lateOne.body.data.id}/accept`);
    await BookingModel.updateOne(
      { _id: lateOne.body.data.id },
      { scheduledStart: new Date(Date.now() + 3600_000), scheduledEnd: new Date(Date.now() + 2 * 3600_000) },
    );
    await as(patient.auth).post(`/bookings/${lateOne.body.data.id}/cancel`, { reason_code: 'wrong_time' });

    const res = await world.book(patient, provider, { scheduled_start: tomorrowAt('16:00') });
    const id = res.body.data.id;
    await world.providerApi(provider, 'post', `/bookings/${id}/accept`);
    await world.providerApi(provider, 'post', `/bookings/${id}/on-the-way`);
    await as(patient.auth).post(`/bookings/${id}/cancel`, { reason_code: 'changed_mind' });
    const fee = (await BookingModel.findById(id).lean())!.price.travelFee;
    const detail = await as(admin.auth).get(`/admin/users/${patient.userId}`);
    expect(detail.body.data.cancellation_record).toEqual({
      late_cancellations: 1,
      travel_fee_charges: { count: 1, total: fee, uncollected: { count: 1, total: fee } },
    });
    expect((await as(admin.auth).get(`/admin/bookings/${id}`)).body.data.booking.patient_fee).toEqual({
      amount: fee,
      reason: 'late_cancellation',
      collected: false,
    });
    expect(
      (await as(admin.auth).get(`/admin/bookings/${lateOne.body.data.id}`)).body.data.booking,
    ).toMatchObject({
      late_cancellation: true,
      patient_fee: null,
    });
  });
});

describe('who bears a dispute refund', () => {
  const completedPaid = async () => {
    const paid = await paidBooking();
    for (const step of ['accept', 'on-the-way', 'start', 'complete']) {
      await world.providerApi(provider, 'post', `/bookings/${paid.bookingId}/${step}`);
    }
    const dispute = await as(patient.auth).post(`/bookings/${paid.bookingId}/dispute`, {
      reason_code: 'late',
    });
    return { ...paid, disputeId: dispute.body.data.id as string };
  };
  const debits = async (bookingId: string) =>
    (await WalletLedgerModel.find({ bookingId, type: 'debit' }).lean()).map((e) => e.amount);

  it('defaults to the provider when they are warned, and debits their share', async () => {
    const admin = await createUserWithToken(UserRole.ADMIN);
    const { bookingId, disputeId } = await completedPaid();
    const res = await as(admin.auth).post(`/admin/disputes/${disputeId}/resolve`, {
      resolution: 'partial_refund',
      refund_amount: 5000,
      provider_action: 'warn',
    });
    expect(res.body.data.resolution).toMatchObject({ refund_bearer: 'provider', provider_share: 5000 });
    expect(await debits(bookingId)).toEqual([-5000]);
  });

  it('platform by default without a provider action; split by amount when chosen', async () => {
    const admin = await createUserWithToken(UserRole.ADMIN);
    const first = await completedPaid();
    await as(admin.auth).post(`/admin/disputes/${first.disputeId}/resolve`, {
      resolution: 'partial_refund',
      refund_amount: 5000,
    });
    expect(await debits(first.bookingId)).toEqual([]);

    const second = await completedPaid();
    const missing = await as(admin.auth).post(`/admin/disputes/${second.disputeId}/resolve`, {
      resolution: 'partial_refund',
      refund_amount: 6000,
      refund_bearer: 'split',
    });
    expect(missing.status).toBe(422);
    const split = await as(admin.auth).post(`/admin/disputes/${second.disputeId}/resolve`, {
      resolution: 'partial_refund',
      refund_amount: 6000,
      refund_bearer: 'split',
      provider_share: 2000,
    });
    expect(split.body.data.resolution).toMatchObject({ refund_bearer: 'split', provider_share: 2000 });
    expect(await debits(second.bookingId)).toEqual([-2000]);
  });
});
