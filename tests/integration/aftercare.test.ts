import request from 'supertest';
import mongoose from 'mongoose';
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
import { clearQueuedPushes, eventually, queuedPushes } from '../helpers/notifications';
import { BookingModel } from '../../src/database/models/booking/booking.model';
import { ProviderProfileModel } from '../../src/database/models/provider/provider-profile.model';
import { UserModel } from '../../src/database/models/user/user.model';
import {
  DisputeModel,
  ReviewModel,
  VisitReportModel,
} from '../../src/database/models/aftercare/aftercare.models';
import { AuditLogModel } from '../../src/database/models/audit-log/audit-log.model';
import { UserRole, UserStatus } from '../../src/interfaces/enums';
import { registerBookingNotifications } from '../../src/services/notification/booking-notifications';
import { containsContact, maskContact } from '../../src/services/aftercare';

useTestDatabase();
const app = createTestApp();
registerBookingNotifications();

let world: BookingWorld;
let patient: TestPatient;
let provider: TestProvider;
let nextHour: number;

beforeEach(async () => {
  world = await createBookingWorld(app);
  patient = await world.newPatient();
  provider = await world.newProvider();
  clearQueuedPushes();
  nextHour = 9;
});

const api = (auth: string) => ({
  get: (path: string) => request(app).get(`/api/v1${path}`).set('Authorization', auth),
  post: (path: string, body?: object) =>
    request(app).post(`/api/v1${path}`).set('Authorization', auth).send(body),
  patch: (path: string, body: object) =>
    request(app).patch(`/api/v1${path}`).set('Authorization', auth).send(body),
});

/** Books with `provider` (each call an hour later tomorrow) and walks the visit up to `until`. */
const visit = async (until: 'accept' | 'start' | 'complete', p = patient, prov = provider) => {
  const booked = await world.book(p, prov, {
    scheduled_start: tomorrowAt(`${String(nextHour++).padStart(2, '0')}:00`),
  });
  expect(booked.status).toBe(201);
  const id: string = booked.body.data.id;
  const steps = ['accept', 'on-the-way', 'start', 'complete'];
  for (const step of steps.slice(0, steps.indexOf(until) + 1)) {
    const res = await world.providerApi(prov, 'post', `/bookings/${id}/${step}`);
    expect(res.status, step).toBe(200);
  }
  return id;
};

const report = {
  summary: 'تم تغيير الغيار، الجرح يلتئم بشكل جيد',
  vitals: { bp: '130/85', pulse: 82, temp: 37.1, sugar: 145, spo2: 97 },
  procedures_done: ['غيار جرح', 'قياس سكر'],
  recommendations: 'متابعة بعد يومين',
};

describe('visit reports', () => {
  it('provider writes a report once the visit started; the patient reads it (encrypted at rest, audited)', async () => {
    const accepted = await visit('accept');
    expect(
      (await api(provider.auth).post(`/provider/bookings/${accepted}/report`, report)).body.error.message,
    ).toBe('لا يمكن كتابة تقرير الزيارة قبل بدئها');

    const id = await visit('start');
    const created = await api(provider.auth).post(`/provider/bookings/${id}/report`, report);
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      booking_id: id,
      summary: report.summary,
      vitals: report.vitals,
    });
    expect((await api(provider.auth).post(`/provider/bookings/${id}/report`, report)).status).toBe(409);

    // Medical text is ciphertext in the database.
    const raw = await mongoose.connection
      .collection('visit_reports')
      .findOne({ bookingId: new mongoose.Types.ObjectId(id) });
    expect(JSON.stringify(raw)).not.toContain('الجرح');
    expect(JSON.stringify(raw)).not.toContain('130/85');

    // Patient is told; the report shows up on the profile, the booking and the list.
    await eventually(() =>
      expect(queuedPushes().some((p) => p.userId === patient.userId && p.data.type === 'visit_report')).toBe(
        true,
      ),
    );
    const reportId: string = created.body.data.id;
    expect((await api(patient.auth).get(`/bookings/${id}`)).body.data.visit_report_id).toBe(reportId);
    expect(
      (await api(patient.auth).get(`/patient-profiles/${patient.selfId}`)).body.data.visit_reports_count,
    ).toBe(1);

    const list = await api(patient.auth).get(`/patient-profiles/${patient.selfId}/visit-reports`);
    expect(list.body.data).toEqual([
      expect.objectContaining({
        id: reportId,
        booking_id: id,
        provider: expect.objectContaining({ id: provider.id }),
      }),
    ]);
    const detail = await api(patient.auth).get(
      `/patient-profiles/${patient.selfId}/visit-reports/${reportId}`,
    );
    expect(detail.body.data).toMatchObject({
      summary: report.summary,
      vitals: report.vitals,
      procedures_done: report.procedures_done,
      recommendations: report.recommendations,
      attachments: [],
    });
    const reads = await AuditLogModel.find({
      action: 'medical_profile.read',
      entityId: patient.selfId,
    }).lean();
    expect(reads.some((r) => r.metadata?.section === 'visit_reports')).toBe(true);
    expect(JSON.stringify(reads)).not.toContain('الجرح');
  });

  it('can be corrected for 24 hours, only by the assigned provider, and only read by the profile owner', async () => {
    const id = await visit('complete');
    const created = await api(provider.auth).post(`/provider/bookings/${id}/report`, report);
    const edited = await api(provider.auth).patch(`/provider/bookings/${id}/report`, {
      recommendations: 'متابعة بعد أسبوع',
      vitals: null,
    });
    expect(edited.status).toBe(200);
    expect(edited.body.data).toMatchObject({
      summary: report.summary,
      recommendations: 'متابعة بعد أسبوع',
      vitals: null,
    });

    const other = await world.newProvider();
    expect(
      (await api(other.auth).patch(`/provider/bookings/${id}/report`, { summary: 'تعديل' })).status,
    ).toBe(404);
    const stranger = await world.newPatient();
    expect(
      (
        await api(stranger.auth).get(
          `/patient-profiles/${patient.selfId}/visit-reports/${created.body.data.id}`,
        )
      ).status,
    ).toBe(404);

    // createdAt is immutable through Mongoose — backdate it in the raw collection.
    await VisitReportModel.collection.updateOne(
      { bookingId: new mongoose.Types.ObjectId(id) },
      { $set: { createdAt: new Date(Date.now() - 25 * 3600_000) } },
    );
    const late = await api(provider.auth).patch(`/provider/bookings/${id}/report`, {
      summary: 'تعديل متأخر',
    });
    expect(late.status).toBe(409);
    expect(late.body.error.message).toBe('انتهت مدة تعديل التقرير (24 ساعة)');
  });

  it('rejects unknown fields and implausible vitals by name', async () => {
    const id = await visit('start');
    const res = await api(provider.auth).post(`/provider/bookings/${id}/report`, {
      ...report,
      vitals: { ...report.vitals, spo2: 140 },
      location: { lat: 30, lng: 31 },
    });
    expect(res.status).toBe(422);
    expect(Object.keys(res.body.error.fields)).toEqual(expect.arrayContaining(['vitals.spo2', 'location']));
  });
});

describe('reviews', () => {
  it('completion asks the patient for a review; one review per completed booking updates the rating', async () => {
    const accepted = await visit('accept');
    expect((await api(patient.auth).post(`/bookings/${accepted}/review`, { rating: 5 })).status).toBe(409);

    const id = await visit('complete');
    await eventually(() =>
      expect(
        queuedPushes().some((p) => p.userId === patient.userId && p.data.type === 'review_request'),
      ).toBe(true),
    );
    expect((await api(patient.auth).get(`/bookings/${id}`)).body.data.can_review).toBe(true);

    const res = await api(patient.auth).post(`/bookings/${id}/review`, {
      rating: 4,
      comment: 'ممرضة محترمة جداً',
      tags: ['punctual', 'professional'],
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ booking_id: id, rating: 4, tags: ['punctual', 'professional'] });
    const again = await api(patient.auth).post(`/bookings/${id}/review`, { rating: 1 });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_REVIEWED');
    expect((await api(patient.auth).get(`/bookings/${id}`)).body.data.can_review).toBe(false);

    const second = await visit('complete');
    await api(patient.auth).post(`/bookings/${second}/review`, { rating: 5 });
    const profile = await ProviderProfileModel.findById(provider.id).lean();
    expect(profile).toMatchObject({ ratingAvg: 4.5, ratingCount: 2 });

    // Public: first name + initial only; newest first; also on the profile card.
    const reviews = await api(patient.auth).get(`/providers/${provider.id}/reviews`);
    expect(reviews.body.meta.total).toBe(2);
    expect(reviews.body.data[0]).toEqual({
      rating: 5,
      comment: null,
      patient_name: expect.stringMatching(/^\S+( \S\.)?$/),
      date: expect.any(String),
    });
    const publicProfile = await api(patient.auth).get(`/providers/${provider.id}`);
    expect(publicProfile.body.data.recent_reviews).toHaveLength(2);
    expect((await api(provider.auth).get('/provider/reviews')).body.meta.total).toBe(2);
  });

  it('only the booking’s patient can review it', async () => {
    const id = await visit('complete');
    const stranger = await world.newPatient();
    expect((await api(stranger.auth).post(`/bookings/${id}/review`, { rating: 5 })).status).toBe(404);
    expect((await api(patient.auth).post(`/bookings/${id}/review`, { rating: 6 })).status).toBe(422);
  });

  it('flags comments with contact details for moderation', async () => {
    const id = await visit('complete');
    await api(patient.auth).post(`/bookings/${id}/review`, {
      rating: 5,
      comment: 'كلموها على ٠١٠٠١٢٣٤٥٦٧ ممتازة',
    });
    expect((await ReviewModel.findOne({ bookingId: id }).lean())!.flagged).toBe(true);
  });
});

describe('contact detection', () => {
  it.each([
    ['call 01001234567', true],
    ['رقمها ٠١٠ ٠١٢٣ ٤٥٦٧', true],
    ['mail me: a.b@example.com', true],
    ['see www.example.com', true],
    ['زيارة 2 مرات في 3 أيام', false],
    ['ممرضة ممتازة', false],
  ])('%s → %s', (text, expected) => {
    expect(containsContact(text)).toBe(expected);
  });

  it('masks every match', () => {
    expect(maskContact('اتصل 01001234567 أو a@b.com')).toBe('اتصل *** أو ***');
  });
});

describe('disputes', () => {
  it('patient reports a problem within the window; the booking becomes disputed', async () => {
    const accepted = await visit('accept');
    expect(
      (await api(patient.auth).post(`/bookings/${accepted}/dispute`, { reason_code: 'late' })).status,
    ).toBe(409);

    const id = await visit('complete');
    const res = await api(patient.auth).post(`/bookings/${id}/dispute`, {
      reason_code: 'unprofessional',
      description: 'تأخرت ساعة',
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ booking_id: id, status: 'open', reason_code: 'unprofessional' });
    expect((await BookingModel.findById(id).lean())!.status).toBe('disputed');
    expect((await api(patient.auth).post(`/bookings/${id}/dispute`, { reason_code: 'late' })).status).toBe(
      409,
    );
  });

  it('is refused once the dispute window has passed', async () => {
    const id = await visit('complete');
    await BookingModel.updateOne({ _id: id }, { completedAt: new Date(Date.now() - 49 * 3600_000) });
    const res = await api(patient.auth).post(`/bookings/${id}/dispute`, { reason_code: 'late' });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe('انتهت المدة المسموح فيها بالإبلاغ عن مشكلة');
  });

  it('admin resolves with a refund + provider suspension; both sides get the messages', async () => {
    const admin = await createUserWithToken(UserRole.ADMIN);
    const id = await visit('complete');
    const upcoming = await visit('accept', await world.newPatient()); // provider's next visit
    const dispute = await api(patient.auth).post(`/bookings/${id}/dispute`, { reason_code: 'no_show' });
    clearQueuedPushes();

    const list = await api(admin.auth).get('/admin/disputes?status=open');
    expect(list.body.data).toEqual([
      expect.objectContaining({ id: dispute.body.data.id, booking_reference: expect.any(String) }),
    ]);

    const resolved = await api(admin.auth).post(`/admin/disputes/${dispute.body.data.id}/resolve`, {
      resolution: 'refund',
      provider_action: 'suspend',
      suspend_days: 7,
      message_to_patient: 'تم رد المبلغ',
      message_to_provider: 'تم إيقافك أسبوعاً',
    });
    expect(resolved.status).toBe(200);
    const total = (await BookingModel.findById(id).lean())!.price.total;
    expect(resolved.body.data).toMatchObject({
      status: 'resolved',
      resolution: { type: 'refund', refund_amount: total, provider_action: 'suspend', suspend_days: 7 },
    });

    expect((await UserModel.findById(provider.userId).lean())!.status).toBe(UserStatus.SUSPENDED);
    expect((await BookingModel.findById(upcoming).lean())!.status).toBe('cancelled');
    await eventually(() => {
      const pushes = queuedPushes().filter((p) => p.data.type === 'dispute');
      expect(pushes.map((p) => p.userId).sort()).toEqual([patient.userId, provider.userId].sort());
    });
    expect(
      await AuditLogModel.exists({ action: 'dispute.resolve', entityId: dispute.body.data.id }),
    ).toBeTruthy();

    const twice = await api(admin.auth).post(`/admin/disputes/${dispute.body.data.id}/resolve`, {
      resolution: 'no_action',
    });
    expect(twice.status).toBe(409);
  });

  it('a partial refund needs an amount within the booking total', async () => {
    const admin = await createUserWithToken(UserRole.ADMIN);
    const id = await visit('complete');
    const dispute = await api(patient.auth).post(`/bookings/${id}/dispute`, { reason_code: 'wrong_price' });
    const url = `/admin/disputes/${dispute.body.data.id}/resolve`;
    expect((await api(admin.auth).post(url, { resolution: 'partial_refund' })).status).toBe(422);
    expect(
      (await api(admin.auth).post(url, { resolution: 'partial_refund', refund_amount: 10_000_000 })).status,
    ).toBe(422);
    const ok = await api(admin.auth).post(url, { resolution: 'partial_refund', refund_amount: 5000 });
    expect(ok.body.data.resolution).toMatchObject({ refund_amount: 5000, provider_action: 'none' });
    expect((await DisputeModel.findById(dispute.body.data.id).lean())!.status).toBe('resolved');
  });
});
