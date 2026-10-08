import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, signTestToken } from '../helpers/app';
import { useTestDatabase } from '../helpers/db';
import { createUser, createUserWithToken } from '../helpers/fixtures';
import { useFakeStorage, sampleFiles } from '../helpers/storage';
import {
  createBookingWorld,
  type BookingWorld,
  type TestPatient,
  type TestProvider,
} from '../helpers/booking-world';
import { ServiceCategoryModel } from '../../src/database/models/catalog/service-category.model';
import { CatalogServiceModel } from '../../src/database/models/catalog/catalog-service.model';
import { AuditLogModel } from '../../src/database/models/audit-log/audit-log.model';
import { NotificationModel } from '../../src/database/models/notification/notification.model';
import { AdminRole, ProviderType, UserRole } from '../../src/interfaces/enums';
import { SettingsService } from '../../src/services/settings';
import { Container } from 'typedi';

/** Clinic visits C1: visit types and prices, clinics (text address), hours, licence, admin review. */

useTestDatabase();
useFakeStorage();
const app = createTestApp();

let world: BookingWorld;
let patient: TestPatient;
let admin: Awaited<ReturnType<typeof createUserWithToken>>;
let consultation: string;
let doctor: TestProvider;

const as = (auth: string) => ({
  get: (path: string) => request(app).get(`/api/v1${path}`).set('Authorization', auth),
  post: (path: string, body?: object) =>
    request(app).post(`/api/v1${path}`).set('Authorization', auth).send(body),
  put: (path: string, body: object) =>
    request(app).put(`/api/v1${path}`).set('Authorization', auth).send(body),
  patch: (path: string, body: object) =>
    request(app).patch(`/api/v1${path}`).set('Authorization', auth).send(body),
  delete: (path: string) => request(app).delete(`/api/v1${path}`).set('Authorization', auth),
});
const adminAs = async (adminRole: AdminRole) => {
  const user = await createUser({ role: UserRole.ADMIN, adminRole });
  return `Bearer ${signTestToken({ id: String(user._id), role: UserRole.ADMIN })}`;
};
const clinicBody = (extra: Record<string, unknown> = {}) => ({
  name: 'عيادة د. منى',
  governorate_id: world.cairo,
  area_id: world.nasrCity,
  street: 'شارع مكرم عبيد',
  building: '12',
  floor: '3',
  landmark: 'أمام سيتي ستارز',
  phone: '+20224001234',
  ...extra,
});
const uploadLicence = async (auth: string) =>
  (
    await request(app)
      .post('/api/v1/uploads')
      .set('Authorization', auth)
      .field('purpose', 'clinic_licence')
      .attach('file', sampleFiles.pdf, { filename: 'licence.pdf', contentType: 'application/pdf' })
      .expect(201)
  ).body.data.file_key as string;
const hours = (day: number, start: string, end: string) => ({
  day_of_week: day,
  start_time: start,
  end_time: end,
});

beforeEach(async () => {
  world = await createBookingWorld(app);
  patient = await world.newPatient();
  admin = await createUserWithToken(UserRole.ADMIN);
  const category = await ServiceCategoryModel.findOne({ key: 'doctor_home_visit' }).lean();
  await ServiceCategoryModel.updateOne({ _id: category!._id }, { isActive: true });
  consultation = String((await CatalogServiceModel.findOne({ nameAr: 'كشف' }).lean())!._id);
  doctor = await world.newProvider({
    services: [{ serviceId: consultation, price: 40000 }],
    overrides: { type: ProviderType.DOCTOR, specialty: 'pediatrics' },
  });
});

describe('visit types and prices', () => {
  it('doctor consultations can be home or clinic visits; nursing stays home only', async () => {
    const services = (await as(patient.auth).get('/services')).body.data as Array<{
      id: string;
      visit_types: string[];
    }>;
    expect(services.find((s) => s.id === consultation)!.visit_types).toEqual(['home_visit', 'clinic_visit']);
    expect(services.find((s) => s.id === world.wound)!.visit_types).toEqual(['home_visit']);
    const refused = await as(admin.auth).patch(`/admin/services/${world.wound}`, {
      visit_types: ['home_visit', 'clinic_visit'],
    });
    expect(refused.status).toBe(422);
    expect(refused.body.error.fields).toHaveProperty('visit_types');
  });

  it('a doctor prices home and clinic visits separately, each within its own bounds', async () => {
    await as(admin.auth)
      .patch(`/admin/services/${consultation}`, { clinic_min_price: 20000, clinic_max_price: 60000 })
      .expect(200);
    const put = (services: object[]) => as(doctor.auth).put('/provider/services', { services });
    const ok = await put([
      { service_id: consultation, price: 50000 },
      { service_id: consultation, price: 35000, visit_type: 'clinic_visit' },
    ]);
    expect(ok.status).toBe(200);
    expect(
      ok.body.data.map((s: { visit_type: string; price: number; max_price: number | null }) => [
        s.visit_type,
        s.price,
        s.max_price,
      ]),
    ).toEqual([
      ['home_visit', 50000, null],
      ['clinic_visit', 35000, 60000],
    ]);
    const duplicate = await put([
      { service_id: consultation, price: 30000, visit_type: 'clinic_visit' },
      { service_id: consultation, price: 31000, visit_type: 'clinic_visit' },
    ]);
    expect(duplicate.body.error.fields).toHaveProperty(['services.1.service_id']);
    expect(
      (await put([{ service_id: consultation, price: 70000, visit_type: 'clinic_visit' }])).body.error.fields,
    ).toHaveProperty(['services.0.price']);

    const nurse = await world.newProvider();
    const nurseClinic = await as(nurse.auth).put('/provider/services', {
      services: [{ service_id: world.wound, price: 25000, visit_type: 'clinic_visit' }],
    });
    expect(nurseClinic.body.error.fields).toHaveProperty(['services.0.visit_type']);
  });

  it('home visits are unchanged: a clinic price never shows in home search or quotes, and clinic quotes wait for C3', async () => {
    await as(doctor.auth)
      .put('/provider/services', {
        services: [{ service_id: consultation, price: 30000, visit_type: 'clinic_visit' }],
      })
      .expect(200);
    const search = await as(patient.auth).get(
      `/providers?service_id=${consultation}&area_id=${world.nasrCity}`,
    );
    expect(search.body.data).toEqual([]);
    expect((await world.quote(patient, doctor, { service_id: consultation })).status).toBe(404);
    const clinicQuote = await world.quote(patient, doctor, {
      service_id: consultation,
      type: 'clinic_visit',
    });
    expect(clinicQuote.status).toBe(422);
    expect(clinicQuote.body.error.fields).toHaveProperty('type');
  });
});

describe('clinics', () => {
  it('text address only, in a bookable area of the governorate; doctors only; a limit per doctor', async () => {
    const created = await as(doctor.auth).post('/provider/clinics', clinicBody());
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      name: 'عيادة د. منى',
      area: { id: world.nasrCity, name: 'مدينة نصر' },
      landmark: 'أمام سيتي ستارز',
      status: 'draft',
      licence: null,
      schedule: { slot_minutes: null, instant_confirm: true, hours: [] },
    });
    const withCoordinates = await as(doctor.auth).post('/provider/clinics', clinicBody({ latitude: 30.05 }));
    expect(withCoordinates.status).toBe(422);
    expect(withCoordinates.body.error.fields).toHaveProperty('latitude');
    expect(
      (
        await as(doctor.auth).post(
          '/provider/clinics',
          clinicBody({ area_id: world.maadi, governorate_id: String(world.nasrCity) }),
        )
      ).status,
    ).toBe(422);

    await Container.get(SettingsService).update({ max_clinics_per_doctor: 1 }, { actorId: null });
    expect((await as(doctor.auth).post('/provider/clinics', clinicBody({ name: 'فرع ثاني' }))).status).toBe(
      409,
    );

    const nurse = await world.newProvider();
    expect((await as(nurse.auth).post('/provider/clinics', clinicBody())).status).toBe(403);
    expect((await as(patient.auth).post('/provider/clinics', clinicBody())).status).toBe(403);
  });

  it('hours never overlap home-visit hours or another clinic; home hours can’t overlap clinic hours', async () => {
    // newProvider works every day 09:00–17:00 (home visits).
    const id = (await as(doctor.auth).post('/provider/clinics', clinicBody())).body.data.id;
    const clash = await as(doctor.auth).put(`/provider/clinics/${id}/schedule`, {
      hours: [hours(1, '16:00', '20:00')],
    });
    expect(clash.status).toBe(422);
    expect(clash.body.error.fields).toHaveProperty(['hours.0']);

    const ok = await as(doctor.auth).put(`/provider/clinics/${id}/schedule`, {
      slot_minutes: 20,
      hours: [hours(1, '18:00', '21:00'), hours(3, '18:00', '21:00')],
    });
    expect(ok.status).toBe(200);
    expect(ok.body.data.schedule).toMatchObject({
      slot_minutes: 20,
      instant_confirm: true,
      hours: [{ day_of_week: 1 }, { day_of_week: 3 }],
    });

    const second = (
      await as(doctor.auth).post(
        '/provider/clinics',
        clinicBody({ name: 'عيادة المعادي', area_id: world.maadi }),
      )
    ).body.data.id;
    expect(
      (
        await as(doctor.auth).put(`/provider/clinics/${second}/schedule`, {
          hours: [hours(3, '20:00', '22:00')],
        })
      ).status,
    ).toBe(422);
    await as(doctor.auth)
      .put(`/provider/clinics/${second}/schedule`, { hours: [hours(5, '18:00', '22:00')] })
      .expect(200);

    const home = await as(doctor.auth).put('/provider/availability', { slots: [hours(1, '09:00', '19:00')] });
    expect(home.status).toBe(422);
    expect(home.body.error.fields).toHaveProperty(['slots.0']);
  });

  it('licence → submit → verifier approves (audited, doctor told); editing the address sends it back', async () => {
    const id = (await as(doctor.auth).post('/provider/clinics', clinicBody())).body.data.id;
    expect((await as(doctor.auth).post(`/provider/clinics/${id}/submit`)).status).toBe(409);
    const licence = await as(doctor.auth).put(`/provider/clinics/${id}/licence`, {
      file_key: await uploadLicence(doctor.auth),
      expires_at: '2029-06-30',
    });
    expect(licence.body.data.licence).toMatchObject({
      expires_at: '2029-06-30',
      file_url: expect.any(String),
    });
    expect((await as(doctor.auth).post(`/provider/clinics/${id}/submit`)).body.data.status).toBe('pending');

    const finance = await adminAs(AdminRole.FINANCE);
    expect((await as(finance).get('/admin/clinics?status=pending')).status).toBe(403);
    const verifier = await adminAs(AdminRole.VERIFIER);
    const queue = await as(verifier).get('/admin/clinics?status=pending');
    expect(queue.body.data.map((c: { id: string }) => c.id)).toEqual([id]);
    expect((await as(verifier).get(`/admin/clinics/${id}`)).body.data.licence.file_url).toEqual(
      expect.any(String),
    );
    const approved = await as(verifier).post(`/admin/clinics/${id}/approve`);
    expect(approved.body.data.status).toBe('approved');
    expect((await as(verifier).post(`/admin/clinics/${id}/approve`)).status).toBe(409);
    expect(await AuditLogModel.exists({ action: 'clinic.approve', entityId: id })).toBeTruthy();
    expect(
      await NotificationModel.exists({ userId: doctor.userId, title: 'تم اعتماد العيادة' }),
    ).toBeTruthy();

    // Pausing doesn't need review; moving does.
    expect(
      (await as(doctor.auth).patch(`/provider/clinics/${id}`, { is_active: false })).body.data.status,
    ).toBe('approved');
    expect(
      (await as(doctor.auth).patch(`/provider/clinics/${id}`, { street: 'شارع عباس العقاد' })).body.data
        .status,
    ).toBe('pending');
    const changes = await as(verifier).post(`/admin/clinics/${id}/request-changes`, {
      message: 'الترخيص لعنوان آخر',
    });
    expect(changes.body.data).toMatchObject({
      status: 'changes_requested',
      admin_message: 'الترخيص لعنوان آخر',
    });
  });

  it('onboarding: a clinic-only doctor needs a clinic with licence and hours, not home areas or hours', async () => {
    const fresh = await world.newProvider({
      services: [],
      areaIds: [],
      availability: [],
      overrides: { type: ProviderType.DOCTOR, specialty: 'pediatrics', verificationStatus: 'draft' as never },
    });
    await as(fresh.auth)
      .put('/provider/services', {
        services: [{ service_id: consultation, price: 30000, visit_type: 'clinic_visit' }],
      })
      .expect(200);
    const checklist = async () => (await as(fresh.auth).get('/provider/profile')).body.data.onboarding;
    expect(await checklist()).toMatchObject({
      areas_selected: true,
      availability_set: true,
      services_set: true,
      clinics_set: false,
    });
    const id = (await as(fresh.auth).post('/provider/clinics', clinicBody())).body.data.id;
    await as(fresh.auth)
      .put(`/provider/clinics/${id}/schedule`, { hours: [hours(2, '17:00', '21:00')] })
      .expect(200);
    expect((await checklist()).clinics_set).toBe(false);
    await as(fresh.auth)
      .put(`/provider/clinics/${id}/licence`, { file_key: await uploadLicence(fresh.auth) })
      .expect(200);
    expect((await checklist()).clinics_set).toBe(true);
  });
});
