import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { Container } from 'typedi';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app';
import { useTestDatabase } from '../helpers/db';
import { createUserWithToken } from '../helpers/fixtures';
import {
  createBookingWorld,
  type BookingWorld,
  type TestPatient,
  type TestProvider,
} from '../helpers/booking-world';
import { eventually } from '../helpers/notifications';
import { ServiceCategoryModel } from '../../src/database/models/catalog/service-category.model';
import { CatalogServiceModel } from '../../src/database/models/catalog/catalog-service.model';
import { ClinicModel } from '../../src/database/models/clinic/clinic.model';
import { ProviderProfileModel } from '../../src/database/models/provider/provider-profile.model';
import { BookingModel } from '../../src/database/models/booking/booking.model';
import { NotificationModel } from '../../src/database/models/notification/notification.model';
import { AuditLogModel } from '../../src/database/models/audit-log/audit-log.model';
import { ProviderType, UserRole } from '../../src/interfaces/enums';
import { BookingType } from '../../src/interfaces/IBooking';
import { ClinicStatus } from '../../src/interfaces/IClinic';
import { SettingsService } from '../../src/services/settings';
import { registerBookingNotifications } from '../../src/services/notification/booking-notifications';
import { setGatewayForTests } from '../../src/services/payments/gateways';
import {
  FakeGateway,
  signFakeWebhook,
  type FakeWebhookBody,
} from '../../src/services/payments/gateways/fake.gateway';
import { addDays, cairoDate, cairoToUtc } from '../../src/utils/time/cairo';

/** Clinic visits C3: booking at a clinic, instant confirmation, visit code, no-show, fees, payments. */

useTestDatabase();
const app = createTestApp();
registerBookingNotifications();

let world: BookingWorld;
let patient: TestPatient;
let consultation: string;
let doctor: TestProvider;
let clinicId: string;

const EVENINGS = Array.from({ length: 7 }, (_, d) => ({
  dayOfWeek: d,
  startTime: '18:00',
  endTime: '21:00',
}));
const at = (time: string, day = addDays(cairoDate(), 1)) => cairoToUtc(day, time).toISOString();
const settings = () => Container.get(SettingsService);

const newDoctor = () =>
  world.newProvider({
    services: [{ serviceId: consultation, price: 50000 }],
    overrides: {
      type: ProviderType.DOCTOR,
      specialty: 'pediatrics',
      services: [
        { serviceId: consultation, price: 50000, isActive: true, visitType: BookingType.HOME_VISIT },
        { serviceId: consultation, price: 30000, isActive: true, visitType: BookingType.CLINIC_VISIT },
      ] as never,
    },
  });
const approvedClinic = async (provider: TestProvider, instantConfirm = true) => {
  const clinic = await ClinicModel.create({
    providerProfileId: provider.id,
    name: 'عيادة د. منى',
    governorateId: world.cairo,
    areaId: world.nasrCity,
    street: 'شارع مكرم عبيد',
    building: '12',
    floor: '3',
    landmark: 'أمام سيتي ستارز',
    phone: '+20224001234',
    status: ClinicStatus.APPROVED,
  });
  await ProviderProfileModel.updateOne(
    { _id: provider.id },
    { $push: { clinics: { clinicId: clinic._id, slotMinutes: 20, instantConfirm, hours: EVENINGS } } },
  );
  return String(clinic._id);
};

const quote = (start: string, extra: Record<string, unknown> = {}, who: TestPatient = patient) =>
  request(app)
    .post('/api/v1/bookings/quote')
    .set('Authorization', who.auth)
    .send({
      service_id: consultation,
      provider_id: doctor.id,
      patient_profile_id: who.selfId,
      type: 'clinic_visit',
      clinic_id: clinicId,
      scheduled_start: start,
      ...extra,
    });
const book = async (start: string, method: 'cash' | 'card' = 'cash', who: TestPatient = patient) => {
  const q = await quote(start, {}, who);
  expect(q.status, JSON.stringify(q.body)).toBe(200);
  return request(app)
    .post('/api/v1/bookings')
    .set('Authorization', who.auth)
    .set('Idempotency-Key', randomUUID())
    .send({ quote_token: q.body.data.quote_token, payment_method: method });
};
const provider = (method: 'get' | 'post', path: string, body?: object) =>
  request(app)[method](`/api/v1/provider${path}`).set('Authorization', doctor.auth).send(body);
const patientGet = (path: string) => request(app).get(`/api/v1${path}`).set('Authorization', patient.auth);

beforeEach(async () => {
  world = await createBookingWorld(app);
  patient = await world.newPatient();
  await ServiceCategoryModel.updateOne({ key: 'doctor_home_visit' }, { isActive: true });
  consultation = String((await CatalogServiceModel.findOne({ nameAr: 'كشف' }).lean())!._id);
  doctor = await newDoctor();
  clinicId = await approvedClinic(doctor);
  await settings().update({ features: { clinic_visits: true } }, { actorId: null });
});

describe('booking a clinic appointment', () => {
  it('no patient address, no travel fee; confirmed at once with the clinic address and a visit code', async () => {
    const q = await quote(at('18:20'));
    expect(q.status).toBe(200);
    expect(q.body.data).toMatchObject({ subtotal: 30000, travel_fee: 0, total: 30000 });

    const created = await book(at('18:20'));
    expect(created.status).toBe(201);
    const id = created.body.data.id;
    const detail = (await patientGet(`/bookings/${id}`)).body.data;
    expect(detail).toMatchObject({
      type: 'clinic_visit',
      status: 'accepted',
      address: {
        label: 'عيادة د. منى',
        landmark: 'أمام سيتي ستارز',
        full_text: expect.stringContaining('شارع مكرم عبيد'),
      },
      clinic: { id: clinicId, name: 'عيادة د. منى', phone: '+20224001234' },
      visit_code: expect.stringMatching(/^\d{4}$/),
    });
    const stored = (await BookingModel.findById(id).lean())!;
    expect(stored).toMatchObject({ addressId: null, assignmentDeadline: null, allowFallback: false });
    await eventually(async () => {
      const titles = (await NotificationModel.find().lean()).map((n) => n.title);
      expect(titles).toEqual(expect.arrayContaining(['تم تأكيد موعدك في العيادة', 'موعد جديد في العيادة']));
    });

    // The appointment is taken; a time that isn't an appointment slot is refused.
    expect((await quote(at('18:20'))).body.error.code).toBe('SLOT_UNAVAILABLE');
    expect((await quote(at('18:10'))).body.error.code).toBe('SLOT_UNAVAILABLE');
    // Home visits still need an address; clinic visits need the clinic.
    expect(
      (await quote(at('18:40'), { type: 'home_visit', clinic_id: null })).body.error.fields,
    ).toHaveProperty('address_id');
    expect((await quote(at('18:40'), { clinic_id: null })).body.error.fields).toHaveProperty('clinic_id');
  });

  it('the clinic commission rate applies when set', async () => {
    await settings().update({ clinic_commission_rate: 10 }, { actorId: null });
    const id = (await book(at('19:00'))).body.data.id;
    expect((await BookingModel.findById(id).lean())!.price.commissionAmount).toBe(3000);
  });

  it('without instant confirmation the doctor answers; unanswered it expires (never falls back)', async () => {
    await ProviderProfileModel.updateOne({ _id: doctor.id }, { $set: { 'clinics.0.instantConfirm': false } });
    const id = (await book(at('19:20'))).body.data.id;
    expect((await BookingModel.findById(id).lean())!.status).toBe('pending');
    await world.passDeadline(id);
    expect((await BookingModel.findById(id).lean())!.status).toBe('expired');
  });

  it('a card appointment is confirmed when the payment lands', async () => {
    setGatewayForTests(new FakeGateway());
    await settings().update({ features: { card_payment: true } }, { actorId: null });
    const created = await book(at('19:40'), 'card');
    expect(created.body.data.status).toBe('awaiting_payment');
    const body: FakeWebhookBody = {
      payment_id: created.body.data.payment_action.payment_id,
      transaction_id: 'tx-clinic',
      status: 'paid',
      amount: 30000,
    };
    await request(app)
      .post('/api/v1/webhooks/payments/fake')
      .set('x-fake-signature', signFakeWebhook(body))
      .send(body)
      .expect(200);
    expect((await BookingModel.findById(created.body.data.id).lean())!).toMatchObject({
      status: 'accepted',
      paymentStatus: 'paid',
    });
  });

  it('rescheduling keeps it confirmed at the new time; admins cannot move it to another doctor', async () => {
    const id = (await book(at('20:00'))).body.data.id;
    const moved = await request(app)
      .post(`/api/v1/bookings/${id}/reschedule`)
      .set('Authorization', patient.auth)
      .send({ scheduled_start: at('20:20') });
    expect(moved.status).toBe(200);
    expect(moved.body.data).toMatchObject({ status: 'accepted', scheduled_start: at('20:20') });

    const admin = await createUserWithToken(UserRole.ADMIN);
    const other = await newDoctor();
    const reassign = await request(app)
      .post(`/api/v1/admin/bookings/${id}/reassign`)
      .set('Authorization', admin.auth)
      .send({ provider_profile_id: other.id });
    expect(reassign.status).toBe(409);
  });
});

describe('at the clinic', () => {
  it('no "on the way"; the doctor starts with the visit code (5 tries)', async () => {
    const id = (await book(at('18:00'))).body.data.id;
    const detail = (await provider('get', `/bookings/${id}`)).body.data;
    expect(detail.allowed_actions).toContain('start_with_code');
    expect(detail.allowed_actions).not.toContain('on_the_way');
    expect(detail.clinic).toEqual({ id: clinicId, name: 'عيادة د. منى' });
    expect((await provider('post', `/bookings/${id}/on-the-way`)).status).toBe(409);

    expect((await provider('post', `/bookings/${id}/start`, {})).body.error.fields).toHaveProperty(
      'visit_code',
    );
    const code = (await BookingModel.findById(id).lean())!.visitCode!;
    const wrong = code === '0000' ? '1111' : '0000';
    expect((await provider('post', `/bookings/${id}/start`, { visit_code: wrong })).status).toBe(422);
    const started = await provider('post', `/bookings/${id}/start`, { visit_code: code });
    expect(started.status).toBe(200);
    expect(started.body.data).toMatchObject({
      status: 'in_progress',
      check_in: { method: 'code', reason: null },
    });
    // The code is no longer shown once the visit started.
    expect((await patientGet(`/bookings/${id}`)).body.data.visit_code).toBeNull();

    const second = (await book(at('18:20'), 'cash', await world.newPatient())).body.data.id;
    for (let i = 0; i < 5; i++) await provider('post', `/bookings/${second}/start`, { visit_code: wrong });
    expect((await provider('post', `/bookings/${second}/start`, { visit_code: code })).body.error.code).toBe(
      'CONFLICT',
    );
  });

  it('starting without the code needs a reason and is audited', async () => {
    const id = (await book(at('18:40'))).body.data.id;
    const res = await provider('post', `/bookings/${id}/start`, { without_code_reason: 'هاتف المريض مغلق' });
    expect(res.body.data.check_in).toMatchObject({ method: 'without_code', reason: 'هاتف المريض مغلق' });
    expect(await AuditLogModel.exists({ action: 'booking.start_without_code', entityId: id })).toBeTruthy();
  });

  it('no-show only after the grace period; clinic fees are a percentage (0 by default)', async () => {
    const id = (await book(at('19:00'))).body.data.id;
    expect((await provider('post', `/bookings/${id}/no-show`)).status).toBe(409);
    await BookingModel.updateOne({ _id: id }, { scheduledStart: new Date(Date.now() - 10 * 60_000) });
    expect((await provider('get', `/bookings/${id}`)).body.data.allowed_actions).not.toContain('no_show');
    expect((await provider('post', `/bookings/${id}/no-show`)).status).toBe(409);
    await BookingModel.updateOne({ _id: id }, { scheduledStart: new Date(Date.now() - 16 * 60_000) });
    expect((await provider('post', `/bookings/${id}/no-show`)).body.data.status).toBe('no_show');
    expect((await BookingModel.findById(id).lean())!.patientFee).toBeNull();
    await eventually(async () =>
      expect(
        await NotificationModel.exists({ userId: patient.userId, title: 'لم تحضر موعد العيادة' }),
      ).toBeTruthy(),
    );

    await settings().update({ clinic_no_show_fee_percent: 50 }, { actorId: null });
    const second = (await book(at('19:20'))).body.data.id;
    await BookingModel.updateOne({ _id: second }, { scheduledStart: new Date(Date.now() - 20 * 60_000) });
    await provider('post', `/bookings/${second}/no-show`).expect(200);
    expect((await BookingModel.findById(second).lean())!.patientFee).toMatchObject({
      amount: 15000,
      reason: 'no_show',
      collected: false,
    });
  });

  it('a late cancellation uses the clinic percentage; within the free window it is free', async () => {
    await settings().update({ clinic_late_cancellation_fee_percent: 20 }, { actorId: null });
    const cancel = (id: string) =>
      request(app)
        .post(`/api/v1/bookings/${id}/cancel`)
        .set('Authorization', patient.auth)
        .send({ reason_code: 'other' });
    const early = (await book(at('20:40'))).body.data.id;
    expect((await cancel(early)).body.data).toMatchObject({ cancellation_fee: 0 });

    const late = (await book(at('20:20'))).body.data.id;
    await BookingModel.updateOne({ _id: late }, { scheduledStart: new Date(Date.now() + 60 * 60_000) });
    expect((await cancel(late)).body.data).toMatchObject({ cancellation_fee: 6000 });
  });
});

describe('against slot hoarding', () => {
  /** A second doctor with a clinic, to test the account-wide rules apart from the same-doctor rule. */
  const otherDoctorQuote = async (start: string, who: TestPatient = patient) => {
    const other = await newDoctor();
    const otherClinic = await approvedClinic(other);
    return quote(start, { provider_id: other.id, clinic_id: otherClinic }, who);
  };

  it('no two clinic appointments at the same time for one account (family members included)', async () => {
    await book(at('18:00')).then((r) => expect(r.status).toBe(201));
    const clash = await otherDoctorQuote(at('18:00'));
    expect(clash.status).toBe(409);
    expect(clash.body.error.message).toContain('في نفس الوقت');
    // A family member's appointment counts toward the same account.
    const family = (
      await request(app)
        .post('/api/v1/patient-profiles')
        .set('Authorization', patient.auth)
        .send({ full_name: 'سامي حسن', relation: 'father', gender: 'male', date_of_birth: '1950-01-01' })
    ).body.data.id;
    expect((await otherDoctorQuote(at('18:00'), { ...patient, selfId: family })).status).toBe(409);
  });

  it('one upcoming appointment with the same doctor per patient profile', async () => {
    await book(at('18:00')).then((r) => expect(r.status).toBe(201));
    const again = await quote(at('19:00'));
    expect(again.status).toBe(409);
    expect(again.body.error.message).toContain('مع هذا الطبيب');
    const family = (
      await request(app)
        .post('/api/v1/patient-profiles')
        .set('Authorization', patient.auth)
        .send({ full_name: 'ليلى حسن', relation: 'mother', gender: 'female', date_of_birth: '1955-01-01' })
    ).body.data.id;
    // Another family member may see the same doctor.
    expect((await quote(at('19:00'), { patient_profile_id: family })).status).toBe(200);
    // Rescheduling the existing one is fine.
    const id = (await BookingModel.findOne({ patientUserId: patient.userId }).lean())!._id;
    const moved = await request(app)
      .post(`/api/v1/bookings/${String(id)}/reschedule`)
      .set('Authorization', patient.auth)
      .send({ scheduled_start: at('19:20') });
    expect(moved.status).toBe(200);
  });

  it('at most max_upcoming_clinic_bookings upcoming in total; finished or cancelled ones free a place', async () => {
    await settings().update({ max_upcoming_clinic_bookings: 2 }, { actorId: null });
    await book(at('18:00')).then((r) => expect(r.status).toBe(201));
    const second = await otherDoctorQuote(at('19:00'));
    expect(second.status).toBe(200);
    await request(app)
      .post('/api/v1/bookings')
      .set('Authorization', patient.auth)
      .set('Idempotency-Key', randomUUID())
      .send({ quote_token: second.body.data.quote_token, payment_method: 'cash' })
      .expect(201);
    const third = await otherDoctorQuote(at('20:00'));
    expect(third.status).toBe(409);
    expect(third.body.error.message).toContain('أكثر من 2');

    await BookingModel.updateOne(
      { patientUserId: patient.userId, scheduledStart: new Date(at('18:00')) },
      { status: 'cancelled' },
    );
    expect((await otherDoctorQuote(at('20:00'))).status).toBe(200);
  });
});
