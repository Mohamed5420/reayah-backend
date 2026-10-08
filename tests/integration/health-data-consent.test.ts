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
  type TestProvider,
} from '../helpers/booking-world';
import { NotificationModel } from '../../src/database/models/notification/notification.model';
import { MedicalConditionModel } from '../../src/database/models/patient/medical-records.model';
import { UserRole } from '../../src/interfaces/enums';

/**
 * Interim rule until counsel answers: withdrawing health-data consent keeps the account and bookings,
 * but pauses health data — not shared with providers, read-only for the patient (with a notice), kept
 * stored. Consenting again restores everything.
 */

useTestDatabase();
const app = createTestApp();

let world: BookingWorld;
let patient: TestPatient;
let legacy: TestPatient; // signed up before any consent text was published
let provider: TestProvider;

const as = (auth: string) => ({
  get: (path: string) => request(app).get(`/api/v1${path}`).set('Authorization', auth),
  post: (path: string, body?: object) =>
    request(app).post(`/api/v1${path}`).set('Authorization', auth).send(body),
  patch: (path: string, body: object) =>
    request(app).patch(`/api/v1${path}`).set('Authorization', auth).send(body),
  delete: (path: string) => request(app).delete(`/api/v1${path}`).set('Authorization', auth),
});
const consent = (accepted: boolean) =>
  as(patient.auth).post('/me/consents', { consents: [{ kind: 'health_data', version: 1, accepted }] });

beforeEach(async () => {
  world = await createBookingWorld(app);
  patient = await world.newPatient();
  legacy = await world.newPatient();
  provider = await world.newProvider();
  const admin = await createUserWithToken(UserRole.ADMIN);
  await as(admin.auth)
    .post('/admin/consent-documents', {
      kind: 'health_data',
      title_ar: 'الموافقة على معالجة البيانات الصحية',
      body_ar: 'نص مؤقت إلى أن يرسل المستشار القانوني الصياغة النهائية.',
    })
    .expect(201);
  await consent(true).expect(200);
  await as(patient.auth).post(`/patient-profiles/${patient.selfId}/conditions`, { name: 'سكر' }).expect(201);
});

const acceptedBooking = async (time: string) => {
  const booked = await world.book(patient, provider, { scheduled_start: tomorrowAt(time) });
  expect(booked.status).toBe(201);
  await world.providerApi(provider, 'post', `/bookings/${booked.body.data.id}/accept`).expect(200);
  return booked.body.data.id as string;
};
const providerView = async (id: string) =>
  (await world.providerApi(provider, 'get', `/bookings/${id}`).expect(200)).body.data;
const titles = async () =>
  (await NotificationModel.find({ userId: patient.userId }).lean()).map((n) => n.title);

describe('health-data consent withdrawn', () => {
  it('pauses sharing and editing, keeps the data and bookings, and consenting again restores it', async () => {
    const id = await acceptedBooking('10:00');
    expect(await providerView(id)).toMatchObject({
      medical_summary: { conditions: ['سكر'] },
      medical_summary_withheld: false,
    });

    // Withdraw.
    expect((await consent(false)).body.data[0]).toMatchObject({ kind: 'health_data', up_to_date: false });
    expect(await titles()).toContain('أوقفنا استخدام بياناتك الصحية');

    // Providers: nothing medical, and told it was withheld.
    expect(await providerView(id)).toMatchObject({ medical_summary: null, medical_summary_withheld: true });

    // Patient: read-only, with the notice; data still stored.
    const profile = (await as(patient.auth).get(`/patient-profiles/${patient.selfId}`).expect(200)).body.data;
    expect(profile).toMatchObject({
      health_data_paused: true,
      conditions: [expect.objectContaining({ name: 'سكر' })],
    });
    expect(profile.health_data_notice).toContain('سحبت موافقتك');
    const refused = await as(patient.auth).post(`/patient-profiles/${patient.selfId}/conditions`, {
      name: 'ضغط',
    });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('HEALTH_DATA_CONSENT_WITHDRAWN');
    expect(refused.body.error.message).toContain('وافق مرة أخرى');
    const conditionId = profile.conditions[0].id;
    expect(
      (await as(patient.auth).delete(`/patient-profiles/${patient.selfId}/conditions/${conditionId}`)).body
        .error.code,
    ).toBe('HEALTH_DATA_CONSENT_WITHDRAWN');
    expect(
      (await as(patient.auth).patch(`/patient-profiles/${patient.selfId}`, { blood_type: 'A+' })).body.error
        .code,
    ).toBe('HEALTH_DATA_CONSENT_WITHDRAWN');
    expect(
      (
        await as(patient.auth).post(`/patient-profiles/${patient.selfId}/documents`, {
          file_key: 'tmp/x/medical_document/y.pdf',
          type: 'lab_result',
          title: 'تحليل',
        })
      ).body.error.code,
    ).toBe('HEALTH_DATA_CONSENT_WITHDRAWN');
    // Family profiles: still allowed without medical fields; with them, refused.
    expect(
      (
        await as(patient.auth).post('/patient-profiles', {
          full_name: 'سامي حسن',
          relation: 'father',
          gender: 'male',
          date_of_birth: '1950-01-01',
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await as(patient.auth).post('/patient-profiles', {
          full_name: 'ليلى حسن',
          relation: 'mother',
          gender: 'female',
          date_of_birth: '1955-01-01',
          blood_type: 'O+',
        })
      ).body.error.code,
    ).toBe('HEALTH_DATA_CONSENT_WITHDRAWN');
    expect(await MedicalConditionModel.countDocuments({ patientProfileId: patient.selfId })).toBe(1);

    // Bookings go on.
    await acceptedBooking('13:00');

    // Consent again: everything is back.
    expect((await consent(true)).body.data[0]).toMatchObject({ up_to_date: true });
    expect(await titles()).toContain('تمت استعادة ملفك الطبي');
    expect(await providerView(id)).toMatchObject({
      medical_summary: { conditions: ['سكر'] },
      medical_summary_withheld: false,
    });
    const restored = (await as(patient.auth).get(`/patient-profiles/${patient.selfId}`)).body.data;
    expect(restored).toMatchObject({ health_data_paused: false, health_data_notice: null });
    await as(patient.auth)
      .post(`/patient-profiles/${patient.selfId}/conditions`, { name: 'ضغط' })
      .expect(201);
  });

  it('never having accepted (signed up before the text existed) is not a withdrawal', async () => {
    const profile = (await as(legacy.auth).get(`/patient-profiles/${legacy.selfId}`)).body.data;
    expect(profile.health_data_paused).toBe(false);
    await as(legacy.auth).post(`/patient-profiles/${legacy.selfId}/conditions`, { name: 'ربو' }).expect(201);
  });
});
