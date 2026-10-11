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
import { ServiceCategoryModel } from '../../src/database/models/catalog/service-category.model';
import { CatalogServiceModel } from '../../src/database/models/catalog/catalog-service.model';
import { ClinicModel } from '../../src/database/models/clinic/clinic.model';
import { ProviderProfileModel } from '../../src/database/models/provider/provider-profile.model';
import { BookingModel } from '../../src/database/models/booking/booking.model';
import { NotificationModel } from '../../src/database/models/notification/notification.model';
import { PackageSubscriptionModel } from '../../src/database/models/marketing/marketing.models';
import { ProviderType, UserRole } from '../../src/interfaces/enums';
import { BookingType } from '../../src/interfaces/IBooking';
import { ClinicStatus } from '../../src/interfaces/IClinic';
import { PackageSubscriptionStatus } from '../../src/interfaces/IMarketing';
import { SettingsService } from '../../src/services/settings';
import { DocumentExpiryService } from '../../src/services/provider';
import { addDays, cairoDate, cairoToUtc } from '../../src/utils/time/cairo';

/** Clinic visits C5: packages and promo codes by visit type, admin filters and analytics, licence expiry. */

useTestDatabase();
const app = createTestApp();

let world: BookingWorld;
let patient: TestPatient;
let admin: Awaited<ReturnType<typeof createUserWithToken>>;
let consultation: string;
let doctor: TestProvider;
let clinicId: string;

const EVENINGS = Array.from({ length: 7 }, (_, d) => ({
  dayOfWeek: d,
  startTime: '18:00',
  endTime: '21:00',
}));
const at = (time: string) => cairoToUtc(addDays(cairoDate(), 1), time).toISOString();
const as = (auth: string) => ({
  get: (path: string) => request(app).get(`/api/v1${path}`).set('Authorization', auth),
  post: (path: string, body?: object) =>
    request(app).post(`/api/v1${path}`).set('Authorization', auth).send(body),
});

const clinicQuote = (start: string, extra: Record<string, unknown> = {}) =>
  as(patient.auth).post('/bookings/quote', {
    service_id: consultation,
    provider_id: doctor.id,
    patient_profile_id: patient.selfId,
    type: 'clinic_visit',
    clinic_id: clinicId,
    scheduled_start: start,
    ...extra,
  });
const bookClinic = async (start: string) => {
  const q = await clinicQuote(start);
  expect(q.status, JSON.stringify(q.body)).toBe(200);
  return request(app)
    .post('/api/v1/bookings')
    .set('Authorization', patient.auth)
    .set('Idempotency-Key', randomUUID())
    .send({ quote_token: q.body.data.quote_token, payment_method: 'cash' });
};
/** An active subscription to a package (the purchase flow is covered in marketing tests). */
const subscription = async (packageId: string, visitType: BookingType) =>
  PackageSubscriptionModel.create({
    packageId,
    patientUserId: patient.userId,
    patientProfileId: patient.selfId,
    package: {
      nameAr: 'باقة',
      nameEn: null,
      organizationId: null,
      serviceId: consultation,
      visitType,
      visitsCount: 4,
      validityDays: 90,
      price: 120000,
      perVisitValue: 30000,
    },
    status: PackageSubscriptionStatus.ACTIVE,
    visitsRemaining: 4,
    startsAt: new Date(),
    expiresAt: new Date(Date.now() + 90 * 24 * 3600_000),
  });

beforeEach(async () => {
  world = await createBookingWorld(app);
  patient = await world.newPatient();
  admin = await createUserWithToken(UserRole.ADMIN);
  await ServiceCategoryModel.updateOne({ key: 'doctor_home_visit' }, { isActive: true });
  consultation = String((await CatalogServiceModel.findOne({ nameAr: 'كشف' }).lean())!._id);
  await Container.get(SettingsService).update(
    { features: { clinic_visits: true, packages: true } },
    { actorId: null },
  );
  doctor = await world.newProvider({
    services: [{ serviceId: consultation, price: 30000 }],
    overrides: {
      type: ProviderType.DOCTOR,
      specialty: 'pediatrics',
      services: [
        { serviceId: consultation, price: 30000, isActive: true, visitType: BookingType.HOME_VISIT },
        { serviceId: consultation, price: 30000, isActive: true, visitType: BookingType.CLINIC_VISIT },
      ] as never,
    },
  });
  const clinic = await ClinicModel.create({
    providerProfileId: doctor.id,
    name: 'عيادة د. منى',
    governorateId: world.cairo,
    areaId: world.nasrCity,
    street: 'شارع مكرم عبيد',
    phone: '+20224001234',
    status: ClinicStatus.APPROVED,
  });
  clinicId = String(clinic._id);
  await ProviderProfileModel.updateOne(
    { _id: doctor.id },
    { $push: { clinics: { clinicId: clinic._id, slotMinutes: 20, instantConfirm: true, hours: EVENINGS } } },
  );
});

describe('packages by visit type', () => {
  it('a clinic package covers clinic visits of the service only (and a home package home visits only)', async () => {
    const created = await as(admin.auth).post('/admin/packages', {
      name_ar: 'باقة كشف في العيادة',
      service_id: consultation,
      visit_type: 'clinic_visit',
      visits_count: 4,
      validity_days: 90,
      price: 120000,
    });
    expect(created.status).toBe(201);
    expect(created.body.data.visit_type).toBe('clinic_visit');
    const nursing = await as(admin.auth).post('/admin/packages', {
      name_ar: 'باقة غيار في العيادة',
      service_id: world.wound,
      visit_type: 'clinic_visit',
      visits_count: 4,
      validity_days: 90,
      price: 100000,
    });
    expect(nursing.body.error.fields).toHaveProperty('visit_type');

    const listed = await as(patient.auth).get(
      `/packages?service_id=${consultation}&area_id=${world.nasrCity}`,
    );
    expect(listed.body.data.map((p: { visit_type: string }) => p.visit_type)).toEqual(['clinic_visit']);

    const clinicSub = await subscription(created.body.data.id, BookingType.CLINIC_VISIT);
    const covered = await clinicQuote(at('18:00'), { package_subscription_id: String(clinicSub._id) });
    expect(covered.status).toBe(200);
    expect(covered.body.data.total).toBe(0);
    const home = await world.quote(patient, doctor, {
      service_id: consultation,
      package_subscription_id: String(clinicSub._id),
    });
    expect(home.body.error.fields).toHaveProperty('package_subscription_id');

    // Search with a package must match its visit type.
    const search = (type: string) =>
      as(patient.auth).get(
        `/providers?service_id=${consultation}&area_id=${world.nasrCity}&visit_type=${type}&package_id=${created.body.data.id}`,
      );
    expect((await search('clinic_visit')).status).toBe(200);
    expect((await search('home_visit')).status).toBe(422);
  });
});

describe('promo codes by visit type', () => {
  it('a code for clinic visits only is refused for home visits', async () => {
    await as(admin.auth)
      .post('/admin/promo-codes', {
        code: 'CLINIC10',
        type: 'percent',
        value: 10,
        visit_types: ['clinic_visit'],
      })
      .expect(201);
    const clinic = await clinicQuote(at('18:20'), { promo_code: 'CLINIC10' });
    expect(clinic.status).toBe(200);
    expect(clinic.body.data.discount).toBe(3000);
    const home = await world.quote(patient, doctor, { service_id: consultation, promo_code: 'CLINIC10' });
    expect(home.body.error.code).toBe('PROMO_INVALID');
    const check = (visitType?: string) =>
      as(patient.auth).post('/promo-codes/validate', {
        code: 'CLINIC10',
        service_id: consultation,
        subtotal: 30000,
        ...(visitType ? { visit_type: visitType } : {}),
      });
    expect((await check('clinic_visit')).status).toBe(200);
    expect((await check()).body.error.code).toBe('PROMO_INVALID');
  });
});

describe('removing a clinic', () => {
  it('is refused while it has appointments to come', async () => {
    const id = (await bookClinic(at('18:00'))).body.data.id;
    const remove = () =>
      request(app).delete(`/api/v1/provider/clinics/${clinicId}`).set('Authorization', doctor.auth);
    const refused = await remove();
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toContain('1');
    await BookingModel.updateOne({ _id: id }, { status: 'cancelled' });
    expect((await remove()).status).toBe(204);
  });
});

describe('admin', () => {
  it('bookings and analytics filter by visit type; clinic visits never started need attention', async () => {
    const clinicBooking = (await bookClinic(at('18:40'))).body.data.id;
    const home = await world.book(patient, doctor, {
      service_id: consultation,
      scheduled_start: at('10:00'),
    });
    expect(home.status).toBe(201);

    const list = await as(admin.auth).get('/admin/bookings?visit_type=clinic_visit');
    expect(list.body.data.map((b: { id: string }) => b.id)).toEqual([clinicBooking]);
    const today = cairoDate();
    const series = await as(admin.auth).get(
      `/admin/analytics?metric=bookings&from=${today}&to=${today}&visit_type=clinic_visit`,
    );
    expect(series.body.data.total).toBe(1);

    await BookingModel.updateOne(
      { _id: clinicBooking },
      {
        scheduledStart: new Date(Date.now() - 4 * 3600_000),
        scheduledEnd: new Date(Date.now() - 3 * 3600_000),
      },
    );
    const attention = (await as(admin.auth).get('/admin/attention')).body.data;
    expect(attention.clinic_visits_not_started.map((b: { id: string }) => b.id)).toEqual([clinicBooking]);
  });

  it('licence expiry: warned once 30 days ahead; when expired the clinic stops being bookable until renewed', async () => {
    await ClinicModel.updateOne(
      { _id: clinicId },
      {
        licence: {
          fileKey: 'clinics/x/licence.pdf',
          uploadedAt: new Date(),
          expiresAt: new Date(Date.now() + 10 * 24 * 3600_000),
        },
      },
    );
    const expiry = Container.get(DocumentExpiryService);
    await expiry.processDaily();
    await expiry.processDaily();
    expect(
      await NotificationModel.countDocuments({ userId: doctor.userId, title: 'ترخيص العيادة ينتهي قريبًا' }),
    ).toBe(1);

    await ClinicModel.updateOne({ _id: clinicId }, { 'licence.expiresAt': new Date(Date.now() - 1000) });
    await expiry.processDaily();
    expect((await ClinicModel.findById(clinicId).lean())!.status).toBe('changes_requested');
    expect(
      await NotificationModel.exists({ userId: doctor.userId, title: 'انتهى ترخيص العيادة' }),
    ).toBeTruthy();
    const search = await as(patient.auth).get(
      `/providers?service_id=${consultation}&area_id=${world.nasrCity}&visit_type=clinic_visit`,
    );
    expect(search.body.data).toEqual([]);
  });
});
