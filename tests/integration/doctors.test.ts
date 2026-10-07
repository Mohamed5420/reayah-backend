import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app';
import { useTestDatabase } from '../helpers/db';
import { createUserWithToken } from '../helpers/fixtures';
import {
  createBookingWorld,
  tomorrowAt,
  type BookingWorld,
  type TestPatient,
} from '../helpers/booking-world';
import { ServiceCategoryModel } from '../../src/database/models/catalog/service-category.model';
import { CatalogServiceModel } from '../../src/database/models/catalog/catalog-service.model';
import { ProviderProfileModel } from '../../src/database/models/provider/provider-profile.model';
import { ProviderType, UserRole } from '../../src/interfaces/enums';
import { SPECIALTIES } from '../../src/services/catalog/specialties';

/** M2.1: doctors as providers — specialties, doctor services, search, booking. */

useTestDatabase();
const app = createTestApp();

let world: BookingWorld;
let patient: TestPatient;
let admin: Awaited<ReturnType<typeof createUserWithToken>>;
let consultation: string;

const as = (auth: string) => ({
  get: (path: string) => request(app).get(`/api/v1${path}`).set('Authorization', auth),
  patch: (path: string, body: object) =>
    request(app).patch(`/api/v1${path}`).set('Authorization', auth).send(body),
  put: (path: string, body: object) =>
    request(app).put(`/api/v1${path}`).set('Authorization', auth).send(body),
});

/** Admins switch the doctor category on for launch (it ships inactive). */
const activateDoctors = async () => {
  const category = await ServiceCategoryModel.findOne({ key: 'doctor_home_visit' }).lean();
  const res = await as(admin.auth).patch(`/admin/service-categories/${category!._id}`, { is_active: true });
  expect(res.status).toBe(200);
};

const newDoctor = (specialty: string, gender?: 'male' | 'female') =>
  world.newProvider({
    services: [{ serviceId: consultation, price: 40000 }],
    ...(gender ? { gender: gender as never } : {}),
    overrides: { type: ProviderType.DOCTOR, specialty },
  });

beforeEach(async () => {
  world = await createBookingWorld(app);
  patient = await world.newPatient();
  admin = await createUserWithToken(UserRole.ADMIN);
  consultation = String((await CatalogServiceModel.findOne({ nameAr: 'كشف منزلي' }).lean())!._id);
});

describe('specialties', () => {
  it('are a public lookup, localized', async () => {
    const ar = await request(app).get('/api/v1/specialties');
    expect(ar.status).toBe(200);
    expect(ar.body.data).toHaveLength(SPECIALTIES.length);
    expect(ar.body.data).toContainEqual({ key: 'internal_medicine', name: 'باطنة' });
    const en = await request(app).get('/api/v1/specialties').set('Accept-Language', 'en');
    expect(en.body.data).toContainEqual({ key: 'internal_medicine', name: 'Internal medicine' });
  });
});

describe('doctor services', () => {
  it('stay hidden until an admin activates the doctor category', async () => {
    const before = await as(patient.auth).get('/services?provider_type=doctor');
    expect(before.body.data).toEqual([]);
    await activateDoctors();
    const after = await as(patient.auth).get('/services?provider_type=doctor');
    expect(after.body.data.map((s: { name: string }) => s.name)).toEqual([
      'كشف منزلي',
      'متابعة منزلية',
      'تقييم شامل لكبار السن',
    ]);
  });
});

describe('doctor onboarding', () => {
  it('a doctor must pick a listed specialty; nurses cannot have one', async () => {
    await activateDoctors();
    const doctor = await createUserWithToken(UserRole.PROVIDER);
    await ProviderProfileModel.create({ userId: doctor.id });
    const profile = as(doctor.auth);

    const base = {
      type: 'doctor',
      years_of_experience: 12,
      license_number: 'LIC-778',
      syndicate_number: 'SYN-778',
    };
    expect((await profile.patch('/provider/profile', base)).body.data.onboarding.profile_completed).toBe(
      false,
    );
    expect((await profile.patch('/provider/profile', { specialty: 'astrology' })).status).toBe(422);

    const done = await profile.patch('/provider/profile', { specialty: 'geriatrics' });
    expect(done.body.data.specialty).toEqual({ key: 'geriatrics', name: 'طب المسنين' });
    expect(done.body.data.onboarding.profile_completed).toBe(true);

    // Doctor services only: a nursing service is refused.
    const nursing = await profile.put('/provider/services', {
      services: [{ service_id: world.wound, price: 25000 }],
    });
    expect(nursing.status).toBe(422);
    expect(
      (await profile.put('/provider/services', { services: [{ service_id: consultation, price: 45000 }] }))
        .status,
    ).toBe(200);

    // Becoming a nurse drops the specialty (and the doctor-only services).
    const nurse = await profile.patch('/provider/profile', { type: 'nurse' });
    expect(nurse.body.data.specialty).toBeNull();
    const refused = await profile.patch('/provider/profile', { specialty: 'pediatrics' });
    expect(refused.status).toBe(422);
    expect(refused.body.error.fields.specialty).toEqual(['التخصص للأطباء فقط']);
  });
});

describe('finding and booking a doctor', () => {
  it('search filters by specialty and shows it on cards and the profile', async () => {
    await activateDoctors();
    const internist = await newDoctor('internal_medicine');
    await newDoctor('pediatrics');

    const all = await as(patient.auth).get(`/providers?area_id=${world.nasrCity}&service_id=${consultation}`);
    expect(all.body.meta.total).toBe(2);
    const filtered = await as(patient.auth).get(
      `/providers?area_id=${world.nasrCity}&service_id=${consultation}&specialty=internal_medicine&provider_type=doctor`,
    );
    expect(filtered.body.data.map((c: { id: string }) => c.id)).toEqual([internist.id]);
    expect(filtered.body.data[0]).toMatchObject({
      type: 'doctor',
      specialty: { key: 'internal_medicine', name: 'باطنة' },
    });

    const profile = await as(patient.auth).get(`/providers/${internist.id}`);
    expect(profile.body.data.specialty).toEqual({ key: 'internal_medicine', name: 'باطنة' });
    // Nursing search never returns doctors.
    const nurses = await as(patient.auth).get(
      `/providers?area_id=${world.nasrCity}&service_id=${world.wound}`,
    );
    expect(nurses.body.data.every((c: { type: string }) => c.type === 'nurse')).toBe(true);
  });

  it('a home consultation books and completes like a nursing visit', async () => {
    await activateDoctors();
    const doctor = await newDoctor('general_practice');
    const booked = await world.book(patient, doctor, {
      service_id: consultation,
      scheduled_start: tomorrowAt('11:00'),
    });
    expect(booked.status).toBe(201);
    const id: string = booked.body.data.id;
    for (const step of ['accept', 'on-the-way', 'start', 'complete']) {
      expect((await world.providerApi(doctor, 'post', `/bookings/${id}/${step}`)).status, step).toBe(200);
    }
    const detail = await as(patient.auth).get(`/bookings/${id}`);
    expect(detail.body.data).toMatchObject({
      status: 'completed',
      service: { name: 'كشف منزلي' },
      can_review: true,
    });
    expect(detail.body.data.price.subtotal).toBe(40000);
  });
});
