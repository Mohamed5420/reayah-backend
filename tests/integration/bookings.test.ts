import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { Container } from 'typedi';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app';
import { useTestDatabase } from '../helpers/db';
import {
  createBookingWorld,
  tomorrowAt,
  type BookingWorld,
  type TestPatient,
} from '../helpers/booking-world';
import { AreaModel } from '../../src/database/models/location/area.model';
import { CatalogServiceModel } from '../../src/database/models/catalog/catalog-service.model';
import { BookingModel } from '../../src/database/models/booking/booking.model';
import { BookingOfferModel } from '../../src/database/models/booking/booking-offer.model';
import { ProviderProfileModel } from '../../src/database/models/provider/provider-profile.model';
import { WalletBalanceModel, WalletLedgerModel } from '../../src/database/models/ledger/wallet.model';
import { AuditLogModel } from '../../src/database/models/audit-log/audit-log.model';
import { Gender } from '../../src/interfaces/enums';
import { BookingDeadlineService } from '../../src/services/booking';
import { bookingEvents, type BookingEvent } from '../../src/events/booking.events';
import { addDays, cairoDate } from '../../src/utils/time/cairo';
import { invalidateCacheNamespace } from '../../src/utils/cache/cache';
import { LOCATIONS_CACHE } from '../../src/services/location';
import { CATALOG_CACHE } from '../../src/services/catalog';

useTestDatabase();
const app = createTestApp();

const events: BookingEvent[] = [];
bookingEvents.subscribe((e) => {
  events.push(e);
});

let world: BookingWorld;
let cairo: string;
let nasrCity: string;
let maadi: string;
let wound: string;
type Patient = TestPatient;
const newPatient = (areaId?: string) => world.newPatient(areaId);
const newProvider = (options?: Parameters<BookingWorld['newProvider']>[0]) => world.newProvider(options);
const quote = (...args: Parameters<BookingWorld['quote']>) => world.quote(...args);
const book = (...args: Parameters<BookingWorld['book']>) => world.book(...args);
const providerApi = (...args: Parameters<BookingWorld['providerApi']>) => world.providerApi(...args);
const passDeadline = (bookingId: string) => world.passDeadline(bookingId);

beforeEach(async () => {
  events.length = 0;
  world = await createBookingWorld(app);
  ({ cairo, nasrCity, maadi, wound } = world);
});

describe('exit criterion: quote → book → accept → on the way → start → complete', () => {
  it('works end to end, with privacy gating, audit, ledger and timeline', async () => {
    const patient = await newPatient();
    await request(app)
      .post(`/api/v1/patient-profiles/${patient.selfId}/conditions`)
      .set('Authorization', patient.auth)
      .send({ name: 'سكر', notes: 'نوع ثاني' })
      .expect(201);
    const provider = await newProvider();

    const q = await quote(patient, provider);
    expect(q.body.data).toMatchObject({
      subtotal: 25000,
      travel_fee: 3000,
      discount: 0,
      platform_fee: 0,
      total: 28000,
      currency: 'EGP',
      lines: [
        { label: 'غيار على جرح × 1', amount: 25000 },
        { label: 'رسوم انتقال (مدينة نصر)', amount: 3000 },
      ],
      cancellation_policy: 'إلغاء مجاني حتى 3 ساعات قبل الموعد',
    });

    const created = await request(app)
      .post('/api/v1/bookings')
      .set('Authorization', patient.auth)
      .set('Idempotency-Key', randomUUID())
      .send({ quote_token: q.body.data.quote_token, payment_method: 'cash' });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      status: 'pending',
      payment_method: 'cash',
      payment_status: 'unpaid',
    });
    expect(created.body.data.reference_code).toMatch(/^RY-[A-Z2-9]{6}$/);
    const id = created.body.data.id;

    // Pending: the provider sees only area, service and time.
    const home = await providerApi(provider, 'get', '/home');
    expect(home.body.data.pending_requests.map((b: { id: string }) => b.id)).toEqual([id]);
    const pending = await providerApi(provider, 'get', `/bookings/${id}`);
    expect(pending.body.data).toMatchObject({
      status: 'pending',
      patient: null,
      address: { area_name: 'مدينة نصر', full_text: null, landmark: null },
      medical_summary: null,
      patient_notes: null,
      allowed_actions: ['accept', 'decline'],
    });

    // Accepted: everything is revealed, and the medical read is audited.
    const accepted = await providerApi(provider, 'post', `/bookings/${id}/accept`);
    expect(accepted.status).toBe(200);
    expect(accepted.body.data).toMatchObject({
      status: 'accepted',
      patient: { full_name: 'أحمد محمود', gender: 'male', phone: patient.phone },
      address: { full_text: '15 شارع عباس العقاد، الدور 4، شقة 12، مدينة نصر، القاهرة' },
      medical_summary: { conditions: ['سكر'], medications: [], allergies: [] },
    });
    expect(
      await AuditLogModel.exists({ action: 'medical_profile.read', entityId: patient.selfId }),
    ).toBeTruthy();

    for (const step of ['on-the-way', 'start', 'complete', 'cash-collected']) {
      expect((await providerApi(provider, 'post', `/bookings/${id}/${step}`)).status).toBe(200);
    }

    const detail = await request(app).get(`/api/v1/bookings/${id}`).set('Authorization', patient.auth);
    expect(detail.body.data).toMatchObject({
      status: 'completed',
      payment_status: 'paid',
      provider: { id: provider.id, name: 'منى حسن', is_verified: true, phone: provider.user.phone },
      price: { subtotal: 25000, travel_fee: 3000, total: 28000 },
      can_cancel: false,
    });
    expect(detail.body.data.timeline.map((t: { status: string }) => t.status)).toEqual([
      'pending',
      'accepted',
      'on_the_way',
      'in_progress',
      'completed',
    ]);

    const booking = await BookingModel.findById(id).lean();
    expect(booking).toMatchObject({ isOnTime: true, completedAt: expect.any(Date) });
    expect((await ProviderProfileModel.findById(provider.id).lean())!.completedVisitsCount).toBe(1);

    // Cash: the nurse holds the money and owes the 15% commission on the subtotal (not on the travel fee).
    const ledger = await WalletLedgerModel.find({ ownerId: provider.profile._id }).lean();
    expect(ledger).toEqual([
      expect.objectContaining({ type: 'commission_due', amount: -3750, balanceAfter: -3750 }),
    ]);
    expect((await WalletBalanceModel.findOne({ ownerId: provider.profile._id }).lean())!.balance).toBe(-3750);

    expect(events.filter((e) => e.type === 'status_changed').map((e) => (e as { to: string }).to)).toEqual([
      'accepted',
      'on_the_way',
      'in_progress',
      'completed',
    ]);
  });
});

describe('quote', () => {
  it('caps the travel fee at the area’s current limit', async () => {
    const patient = await newPatient();
    const provider = await newProvider();
    await AreaModel.updateOne({ _id: nasrCity }, { maxTravelFee: 2000 });
    await invalidateCacheNamespace(LOCATIONS_CACHE);
    expect((await quote(patient, provider)).body.data).toMatchObject({ travel_fee: 2000, total: 27000 });
  });

  it.each([
    ['another user’s address', 'address', 404],
    ['an area the provider doesn’t cover', 'area', 422],
    ['a time that isn’t a free slot', 'time', 409],
    ['a gender that doesn’t match', 'gender', 422],
    ['video (Phase 2)', 'video', 422],
    ['an organization (Phase 3)', 'organization', 422],
  ])('refuses %s', async (_label, kind, status) => {
    const patient = await newPatient();
    const provider = await newProvider();
    const maadiAddress = await request(app)
      .post('/api/v1/addresses')
      .set('Authorization', patient.auth)
      .send({ label: 'بيت ماما', governorate_id: cairo, area_id: maadi, street: 'شارع 9' });
    const overrides: Record<string, Record<string, unknown>> = {
      address: { address_id: (await newPatient()).addressId },
      area: { address_id: maadiAddress.body.data.id },
      time: { scheduled_start: tomorrowAt('10:10') },
      gender: { preferred_gender: 'male' },
      video: { type: 'video' },
      organization: { organization_id: provider.id },
    };
    expect((await quote(patient, provider, overrides[kind])).status).toBe(status);
  });

  it('refuses a provider whose price fell outside bounds the admin tightened later', async () => {
    const patient = await newPatient();
    const provider = await newProvider();
    await CatalogServiceModel.updateOne({ _id: wound }, { maxPrice: 20000 });
    await invalidateCacheNamespace(CATALOG_CACHE);
    const res = await quote(patient, provider);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe('سعر مقدم الخدمة لم يعد متاحاً لهذه الخدمة، اختر مقدم خدمة آخر');
  });
});

describe('creating a booking', () => {
  it('refuses forged or foreign quote tokens and non-cash payment', async () => {
    const patient = await newPatient();
    const other = await newPatient();
    const provider = await newProvider();
    const q = await quote(patient, provider);
    const send = (p: Patient, body: Record<string, unknown>) =>
      request(app)
        .post('/api/v1/bookings')
        .set('Authorization', p.auth)
        .set('Idempotency-Key', randomUUID())
        .send(body);

    expect(
      (await send(other, { quote_token: q.body.data.quote_token, payment_method: 'cash' })).body.error.fields,
    ).toEqual({
      quote_token: ['انتهت صلاحية عرض السعر، اطلب عرض سعر جديد'],
    });
    expect((await send(patient, { quote_token: 'forged', payment_method: 'cash' })).status).toBe(422);
    expect(
      (await send(patient, { quote_token: q.body.data.quote_token, payment_method: 'card' })).body.error
        .fields,
    ).toEqual({
      payment_method: ['الدفع النقدي فقط متاح حالياً'],
    });
  });

  it('is idempotent: retrying with the same key returns the same booking', async () => {
    const patient = await newPatient();
    const provider = await newProvider();
    const q = await quote(patient, provider);
    const key = randomUUID();
    const send = () =>
      request(app)
        .post('/api/v1/bookings')
        .set('Authorization', patient.auth)
        .set('Idempotency-Key', key)
        .send({ quote_token: q.body.data.quote_token, payment_method: 'cash' });
    const first = await send();
    const second = await send();
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(await BookingModel.countDocuments()).toBe(1);
  });

  it('two patients racing for the same slot: exactly one gets it', async () => {
    const provider = await newProvider();
    const [a, b] = await Promise.all([newPatient(), newPatient()]);
    const [qa, qb] = await Promise.all([quote(a, provider), quote(b, provider)]);
    const results = await Promise.all(
      [
        [a, qa],
        [b, qb],
      ].map(([p, q]) =>
        request(app)
          .post('/api/v1/bookings')
          .set('Authorization', (p as Patient).auth)
          .set('Idempotency-Key', randomUUID())
          .send({ quote_token: (q as request.Response).body.data.quote_token, payment_method: 'cash' }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body.error.code).toBe('SLOT_UNAVAILABLE');
    expect(await BookingModel.countDocuments()).toBe(1);
  });

  it('a requested slot shows as taken to everyone else', async () => {
    const provider = await newProvider();
    await book(await newPatient(), provider);
    const slots = await request(app)
      .get(`/api/v1/providers/${provider.id}/slots`)
      .query({ service_id: wound, date: addDays(cairoDate(), 1) })
      .set('Authorization', (await newPatient()).auth);
    const ten = slots.body.data.slots.find((s: { start: string }) => s.start === tomorrowAt('10:00'));
    expect(ten.available).toBe(false);
  });
});

describe('deadlines and fallback', () => {
  it('no answer and no fallback allowed → expired', async () => {
    const created = await book(await newPatient(), await newProvider(), { allow_fallback: false });
    await passDeadline(created.body.data.id);
    expect((await BookingModel.findById(created.body.data.id).lean())!.status).toBe('expired');
  });

  it('the provider can’t accept after the deadline, even before the sweep runs', async () => {
    const provider = await newProvider();
    const created = await book(await newPatient(), provider);
    await BookingModel.updateOne(
      { _id: created.body.data.id },
      { assignmentDeadline: new Date(Date.now() - 1000) },
    );
    const res = await providerApi(provider, 'post', `/bookings/${created.body.data.id}/accept`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ASSIGNMENT_DEADLINE_PASSED');
  });

  it('no answer → offered to other eligible providers; first to accept wins, the rest lose', async () => {
    const first = await newProvider();
    const x = await newProvider();
    const y = await newProvider({ gender: Gender.FEMALE });
    await newProvider({ areaIds: [maadi] }); // wrong area: not offered
    const created = await book(await newPatient(), first);
    const id = created.body.data.id;

    await passDeadline(id);
    const booking = await BookingModel.findById(id).lean();
    expect(booking).toMatchObject({
      status: 'pending',
      assignmentMode: 'broadcast',
      providerProfileId: null,
    });
    const offers = await BookingOfferModel.find({ bookingId: id }).lean();
    expect(offers.map((o) => String(o.providerProfileId)).sort()).toEqual([x.id, y.id].sort());
    expect((await providerApi(first, 'get', `/bookings/${id}`)).status).toBe(404);

    const [xOffers, yOffers] = await Promise.all([
      providerApi(x, 'get', '/offers'),
      providerApi(y, 'get', '/offers'),
    ]);
    const [rx, ry] = await Promise.all([
      providerApi(x, 'post', `/offers/${xOffers.body.data[0].id}/accept`),
      providerApi(y, 'post', `/offers/${yOffers.body.data[0].id}/accept`),
    ]);
    expect([rx.status, ry.status].sort()).toEqual([200, 409]);
    expect([rx, ry].find((r) => r.status === 409)!.body.error.code).toBe('OFFER_TAKEN');

    const winner = rx.status === 200 ? x : y;
    expect(String((await BookingModel.findById(id).lean())!.providerProfileId)).toBe(winner.id);
    expect((await BookingOfferModel.find({ bookingId: id }).lean()).map((o) => o.status).sort()).toEqual([
      'accepted',
      'lost',
    ]);
  });

  it('nobody accepts the broadcast → expired, offers expired', async () => {
    const created = await book(await newPatient(), await newProvider());
    await newProvider();
    await passDeadline(created.body.data.id);
    await BookingModel.updateOne(
      { _id: created.body.data.id },
      { fallbackEndsAt: new Date(Date.now() - 1000) },
    );
    await Container.get(BookingDeadlineService).processDue();
    expect((await BookingModel.findById(created.body.data.id).lean())!.status).toBe('expired');
    expect((await BookingOfferModel.find().lean()).map((o) => o.status)).toEqual(['expired']);
  });
});

describe('a provider can never be double-booked', () => {
  it('accepting two overlapping offers at once: one succeeds, one gets SLOT_UNAVAILABLE', async () => {
    const [y, z] = await Promise.all([newProvider(), newProvider()]);
    const x = await newProvider();
    const one = await book(await newPatient(), y);
    const two = await book(await newPatient(), z);
    await passDeadline(one.body.data.id);
    await passDeadline(two.body.data.id);

    const offers = await providerApi(x, 'get', '/offers');
    expect(offers.body.data).toHaveLength(2);
    const results = await Promise.all(
      offers.body.data.map((o: { id: string }) => providerApi(x, 'post', `/offers/${o.id}/accept`)),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body.error.code).toBe('SLOT_UNAVAILABLE');
    expect(await BookingModel.countDocuments({ providerProfileId: x.profile._id, status: 'accepted' })).toBe(
      1,
    );
  });
});

describe('patient cancel and reschedule', () => {
  it('cancel: free while pending; after acceptance only until 3 h before', async () => {
    const provider = await newProvider();
    const patient = await newPatient();
    const pending = await book(patient, provider);
    const cancelled = await request(app)
      .post(`/api/v1/bookings/${pending.body.data.id}/cancel`)
      .set('Authorization', patient.auth)
      .send({ reason_code: 'changed_mind' });
    expect(cancelled.body.data).toEqual({ status: 'cancelled', cancellation_fee: 0, refund_amount: 0 });

    const accepted = await book(patient, provider, { scheduled_start: tomorrowAt('12:00') });
    await providerApi(provider, 'post', `/bookings/${accepted.body.data.id}/accept`).expect(200);
    await BookingModel.updateOne(
      { _id: accepted.body.data.id },
      { scheduledStart: new Date(Date.now() + 3600_000), scheduledEnd: new Date(Date.now() + 2 * 3600_000) },
    );
    const late = await request(app)
      .post(`/api/v1/bookings/${accepted.body.data.id}/cancel`)
      .set('Authorization', patient.auth)
      .send({ reason_code: 'wrong_time' });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('CANCELLATION_NOT_ALLOWED');
  });

  it('reschedule sends an accepted booking back to pending at the new time', async () => {
    const provider = await newProvider();
    const patient = await newPatient();
    const created = await book(patient, provider);
    await providerApi(provider, 'post', `/bookings/${created.body.data.id}/accept`).expect(200);
    const res = await request(app)
      .post(`/api/v1/bookings/${created.body.data.id}/reschedule`)
      .set('Authorization', patient.auth)
      .send({ scheduled_start: tomorrowAt('14:00') });
    expect(res.body.data).toMatchObject({ status: 'pending', scheduled_start: tomorrowAt('14:00') });
    // The old time is free again.
    expect((await book(await newPatient(), provider)).status).toBe(201);
  });

  it('rebook returns a fresh quote for the same provider and service', async () => {
    const provider = await newProvider();
    const patient = await newPatient();
    const created = await book(patient, provider);
    const res = await request(app)
      .post(`/api/v1/bookings/${created.body.data.id}/rebook`)
      .set('Authorization', patient.auth)
      .send({ scheduled_start: tomorrowAt('15:00') });
    expect(res.body.data).toMatchObject({ total: 28000, quote_token: expect.any(String) });
  });
});

describe('provider actions follow the state machine', () => {
  it('rejects out-of-order steps, early no-shows, and other providers’ bookings', async () => {
    const provider = await newProvider();
    const created = await book(await newPatient(), provider);
    const id = created.body.data.id;
    const early = await providerApi(provider, 'post', `/bookings/${id}/on-the-way`);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('INVALID_STATUS_TRANSITION');

    await providerApi(provider, 'post', `/bookings/${id}/accept`).expect(200);
    expect((await providerApi(provider, 'post', `/bookings/${id}/no-show`)).body.error.message).toBe(
      'لا يمكن تسجيل عدم الحضور قبل موعد الزيارة',
    );
    const stranger = await newProvider();
    expect((await providerApi(stranger, 'post', `/bookings/${id}/start`)).status).toBe(404);
  });
});

describe('earlier milestones’ follow-ups', () => {
  it('blocks deleting an address or the account while a booking is active; shows it on /home', async () => {
    const patient = await newPatient();
    await book(patient, await newProvider());
    const address = await request(app)
      .delete(`/api/v1/addresses/${patient.addressId}`)
      .set('Authorization', patient.auth);
    expect(address.status).toBe(409);
    const account = await request(app).delete('/api/v1/me').set('Authorization', patient.auth).send({});
    expect(account.status).toBe(409);

    const home = await request(app).get('/api/v1/home').set('Authorization', patient.auth);
    expect(home.body.data.upcoming_booking).toMatchObject({
      status: 'pending',
      service_name: 'غيار على جرح',
      scheduled_start: tomorrowAt('10:00'),
      provider_name: 'منى حسن',
    });
  });
});
