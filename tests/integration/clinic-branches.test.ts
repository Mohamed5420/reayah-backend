import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { Container } from 'typedi';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app';
import { useTestDatabase } from '../helpers/db';
import { loginWithOtp, randomPhone, signUp } from '../helpers/fixtures';
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
import { OrganizationModel } from '../../src/database/models/organization/organization.models';
import { ProviderTimeOffModel } from '../../src/database/models/provider/provider-time-off.model';
import { BookingModel } from '../../src/database/models/booking/booking.model';
import { NotificationModel } from '../../src/database/models/notification/notification.model';
import { AuditLogModel } from '../../src/database/models/audit-log/audit-log.model';
import { Gender, ProviderType, UserRole, VerificationStatus } from '../../src/interfaces/enums';
import { BookingType } from '../../src/interfaces/IBooking';
import { ClinicStatus } from '../../src/interfaces/IClinic';
import { SettingsService } from '../../src/services/settings';
import { registerBookingNotifications } from '../../src/services/notification/booking-notifications';
import { addDays, cairoDate, cairoToUtc } from '../../src/utils/time/cairo';

/** Clinic visits C4: organization branches, doctors at branches, booking a branch, deadline rule, reception. */

useTestDatabase();
const app = createTestApp();
registerBookingNotifications();

type Owner = { auth: string; userId: string; orgId: string };
let world: BookingWorld;
let patient: TestPatient;
let consultation: string;
let owner: Owner;
let sara: TestProvider; // doctor, female
let omar: TestProvider; // doctor, male
let branchId: string;

const EVENINGS = Array.from({ length: 7 }, (_, d) => ({
  day_of_week: d,
  start_time: '18:00',
  end_time: '21:00',
}));
const at = (time: string, day = addDays(cairoDate(), 1)) => cairoToUtc(day, time).toISOString();

const api = (auth: string) => ({
  get: (path: string) => request(app).get(`/api/v1${path}`).set('Authorization', auth),
  post: (path: string, body?: object) =>
    request(app).post(`/api/v1${path}`).set('Authorization', auth).send(body),
  put: (path: string, body: object) =>
    request(app).put(`/api/v1${path}`).set('Authorization', auth).send(body),
  delete: (path: string) => request(app).delete(`/api/v1${path}`).set('Authorization', auth),
});

const newOrg = async (): Promise<Owner> => {
  const session = await signUp(app, UserRole.OWNER);
  const org = await OrganizationModel.create({
    ownerUserId: session.user.id,
    name: 'مستشفى الشفاء',
    type: 'clinic',
    commercialRegisterNo: String(Math.random()).slice(2, 10),
    taxId: '987-654-321',
    verificationStatus: VerificationStatus.APPROVED,
    services: [
      { serviceId: consultation, price: 40000, isActive: true, visitType: BookingType.CLINIC_VISIT },
    ],
  });
  return { auth: `Bearer ${session.access_token}`, userId: session.user.id, orgId: String(org._id) };
};
const newStaffDoctor = (orgId: string, gender: Gender, ratingAvg: number) =>
  world.newProvider({
    gender,
    ratingAvg,
    services: [],
    overrides: { organizationId: orgId as never, type: ProviderType.DOCTOR, specialty: 'pediatrics' },
    userOverrides: { role: UserRole.PROVIDER_STAFF },
  });
const branchBody = {
  name: 'فرع مدينة نصر',
  governorate_id: '',
  area_id: '',
  street: 'شارع عباس العقاد',
  building: '20',
  landmark: 'بجوار جنينة مول',
  phone: '+20222223333',
};
const quote = (start: string, extra: Record<string, unknown> = {}, who: TestPatient = patient) =>
  api(who.auth).post('/bookings/quote', {
    service_id: consultation,
    organization_id: owner.orgId,
    patient_profile_id: who.selfId,
    type: 'clinic_visit',
    clinic_id: branchId,
    scheduled_start: start,
    ...extra,
  });
const book = async (start: string, extra: Record<string, unknown> = {}, who: TestPatient = patient) => {
  const q = await quote(start, extra, who);
  expect(q.status, JSON.stringify(q.body)).toBe(200);
  return request(app)
    .post('/api/v1/bookings')
    .set('Authorization', who.auth)
    .set('Idempotency-Key', randomUUID())
    .send({ quote_token: q.body.data.quote_token, payment_method: 'cash' });
};

beforeEach(async () => {
  world = await createBookingWorld(app);
  patient = await world.newPatient();
  await ServiceCategoryModel.updateOne({ key: 'doctor_home_visit' }, { isActive: true });
  consultation = String((await CatalogServiceModel.findOne({ nameAr: 'كشف' }).lean())!._id);
  await Container.get(SettingsService).update({ features: { clinic_visits: true } }, { actorId: null });
  owner = await newOrg();
  sara = await newStaffDoctor(owner.orgId, Gender.FEMALE, 4.8);
  omar = await newStaffDoctor(owner.orgId, Gender.MALE, 4.2);
  const created = await api(owner.auth).post('/org/branches', {
    ...branchBody,
    governorate_id: world.cairo,
    area_id: world.nasrCity,
  });
  expect(created.status).toBe(201);
  branchId = created.body.data.id;
  await ClinicModel.updateOne({ _id: branchId }, { status: ClinicStatus.APPROVED });
  for (const doctor of [sara, omar]) {
    await api(owner.auth)
      .put(`/org/branches/${branchId}/doctors/${doctor.id}`, { slot_minutes: 20, hours: EVENINGS })
      .expect(200);
  }
});

describe('branches', () => {
  it('owners place doctors at branches with hours; the same overlap rules; other owners never see them', async () => {
    const list = (await api(owner.auth).get('/org/branches')).body.data;
    expect(list).toEqual([
      expect.objectContaining({
        id: branchId,
        status: 'approved',
        doctors: expect.arrayContaining([
          expect.objectContaining({ staff_id: sara.id, appointment_minutes: 20 }),
        ]),
      }),
    ]);
    // newProvider works 09:00–17:00 at home: branch hours can't overlap that.
    const clash = await api(owner.auth).put(`/org/branches/${branchId}/doctors/${sara.id}`, {
      hours: [{ day_of_week: 1, start_time: '16:00', end_time: '19:00' }],
    });
    expect(clash.status).toBe(422);
    const nurse = await world.newProvider({
      overrides: { organizationId: owner.orgId as never },
      userOverrides: { role: UserRole.PROVIDER_STAFF },
    });
    expect(
      (await api(owner.auth).put(`/org/branches/${branchId}/doctors/${nurse.id}`, { hours: EVENINGS }))
        .status,
    ).toBe(409);
    const other = await newOrg();
    expect(
      (await api(other.auth).put(`/org/branches/${branchId}/doctors/${sara.id}`, { hours: EVENINGS })).status,
    ).toBe(404);
  });

  it('search: one card per branch (organization price, its doctors), branch slots and the public profile', async () => {
    const res = await api(patient.auth).get(
      `/providers?service_id=${consultation}&area_id=${world.nasrCity}&visit_type=clinic_visit`,
    );
    expect(res.body.data).toEqual([
      expect.objectContaining({
        kind: 'organization',
        id: owner.orgId,
        visit_type: 'clinic_visit',
        clinic: { id: branchId, name: 'فرع مدينة نصر', area: { id: world.nasrCity, name: 'مدينة نصر' } },
        price: 40000,
        travel_fee: 0,
        team_size: 2,
      }),
    ]);
    const female = await api(patient.auth).get(
      `/providers?service_id=${consultation}&area_id=${world.nasrCity}&visit_type=clinic_visit&gender=female`,
    );
    expect(female.body.data[0].team_size).toBe(1);

    const slots = (path: string) =>
      api(patient.auth).get(
        `/providers/${owner.orgId}/slots?service_id=${consultation}&date=${addDays(cairoDate(), 1)}&visit_type=clinic_visit&clinic_id=${branchId}${path}`,
      );
    await ProviderTimeOffModel.create({
      providerProfileId: sara.id,
      startsAt: cairoToUtc(addDays(cairoDate(), 1), '18:00'),
      endsAt: cairoToUtc(addDays(cairoDate(), 1), '18:20'),
    });
    expect((await slots('')).body.data.slots[0].available).toBe(true); // Omar is free
    expect((await slots(`&doctor_id=${sara.id}`)).body.data.slots[0].available).toBe(false);

    const profile = (await api(patient.auth).get(`/providers/${owner.orgId}`)).body.data;
    expect(profile.visit_types).toContain('clinic_visit');
    expect(profile.clinics).toEqual([
      expect.objectContaining({
        id: branchId,
        street: 'شارع عباس العقاد',
        services: [expect.objectContaining({ price: 40000 })],
        doctors: expect.arrayContaining([expect.objectContaining({ id: sara.id, appointment_minutes: 20 })]),
      }),
    ]);
    expect(JSON.stringify(profile)).not.toContain('+20222223333');
  });
});

describe('booking a branch', () => {
  it('a specific doctor is confirmed at once; the organization earns it', async () => {
    const created = await book(at('18:20'), { provider_id: sara.id });
    expect(created.status).toBe(201);
    const stored = (await BookingModel.findById(created.body.data.id).lean())!;
    expect(stored).toMatchObject({
      status: 'accepted',
      assignmentMode: 'organization',
      allowFallback: false,
    });
    expect(String(stored.providerProfileId)).toBe(sara.id);
    expect(String(stored.organizationId)).toBe(owner.orgId);
    expect(stored.price.travelFee).toBe(0);
  });

  it('any doctor: the owner assigns someone at that branch only', async () => {
    const id = (await book(at('18:40'))).body.data.id;
    expect((await BookingModel.findById(id).lean())!).toMatchObject({
      status: 'pending',
      providerProfileId: null,
    });
    const elsewhere = await newStaffDoctor(owner.orgId, Gender.FEMALE, 5);
    const eligible = (await api(owner.auth).get(`/org/bookings/${id}/eligible-staff`)).body.data;
    expect(eligible.find((e: { id: string }) => e.id === elsewhere.id)).toMatchObject({
      available: false,
      reason: 'branch',
    });
    expect(
      (await api(owner.auth).post(`/org/bookings/${id}/assign`, { provider_profile_id: elsewhere.id }))
        .status,
    ).toBe(409);
    const assigned = await api(owner.auth).post(`/org/bookings/${id}/assign`, {
      provider_profile_id: omar.id,
    });
    expect(assigned.status).toBe(200);
    expect(String((await BookingModel.findById(id).lean())!.providerProfileId)).toBe(omar.id);
  });

  it('deadline: a free doctor at the same branch takes it; with none free it expires and the patient chooses again', async () => {
    const first = (await book(at('19:00'))).body.data.id;
    await world.passDeadline(first);
    const taken = (await BookingModel.findById(first).lean())!;
    expect(taken.status).toBe('accepted');
    expect(String(taken.providerProfileId)).toBe(sara.id); // highest rated

    const other = await world.newPatient();
    const second = (await book(at('19:20'), {}, other)).body.data.id;
    for (const doctor of [sara, omar]) {
      await ProviderTimeOffModel.create({
        providerProfileId: doctor.id,
        startsAt: cairoToUtc(addDays(cairoDate(), 1), '19:20'),
        endsAt: cairoToUtc(addDays(cairoDate(), 1), '19:40'),
      });
    }
    await world.passDeadline(second);
    expect((await BookingModel.findById(second).lean())!.status).toBe('expired');
    await eventually(async () =>
      expect(
        await NotificationModel.exists({ userId: other.userId, title: 'لم يتم تأكيد موعد العيادة' }),
      ).toBeTruthy(),
    );
  });

  it('auto-assign spreads the load: the doctor with the fewest appointments that day at the branch', async () => {
    // Sara (higher rating) already has an appointment that day at this branch.
    await book(at('18:00'), { provider_id: sara.id }, await world.newPatient()).then((r) =>
      expect(r.status).toBe(201),
    );
    const id = (await book(at('19:00'))).body.data.id;
    await world.passDeadline(id);
    const taken = (await BookingModel.findById(id).lean())!;
    expect(taken.status).toBe('accepted');
    expect(String(taken.providerProfileId)).toBe(omar.id);
  });

  it('auto-assign respects the preferred gender: no matching doctor free → expired, never someone else', async () => {
    const id = (await book(at('20:00'), { preferred_gender: 'female' })).body.data.id;
    await ProviderTimeOffModel.create({
      providerProfileId: sara.id,
      startsAt: cairoToUtc(addDays(cairoDate(), 1), '20:00'),
      endsAt: cairoToUtc(addDays(cairoDate(), 1), '20:20'),
    });
    await world.passDeadline(id);
    const after = (await BookingModel.findById(id).lean())!;
    expect(after.status).toBe('expired');
    expect(after.providerProfileId).toBeNull(); // Omar was free but not the patient's choice
  });

  it('reports by branch', async () => {
    const id = (await book(at('18:00'), { provider_id: omar.id })).body.data.id;
    await BookingModel.updateOne({ _id: id }, { status: 'completed', completedAt: new Date() });
    const day = addDays(cairoDate(), 1);
    const report = (await api(owner.auth).get(`/org/reports?from=${day}&to=${day}&group_by=branch`)).body
      .data;
    expect(report.rows).toEqual([
      expect.objectContaining({ key: branchId, label: 'فرع مدينة نصر', visits: 1 }),
    ]);
  });
});

describe('owner queue and removals', () => {
  it('the queue names the branch of each clinic visit and filters by branch', async () => {
    const id = (await book(at('18:40'))).body.data.id;
    const other = await api(owner.auth).post('/org/branches', {
      ...branchBody,
      name: 'فرع آخر',
      governorate_id: world.cairo,
      area_id: world.nasrCity,
    });
    const list = (q: string) => api(owner.auth).get(`/org/bookings${q}`);
    const item = (await list('')).body.data.find((b: { id: string }) => b.id === id);
    expect(item.clinic).toEqual({ id: branchId, name: branchBody.name });
    expect((await list(`?branch_id=${branchId}`)).body.data.map((b: { id: string }) => b.id)).toEqual([id]);
    expect((await list(`?branch_id=${other.body.data.id}`)).body.data).toEqual([]);
  });

  it('a doctor with appointments to come can’t be taken off the branch, nor the branch removed', async () => {
    const id = (await book(at('18:20'), { provider_id: sara.id })).body.data.id;
    const offSara = await api(owner.auth).delete(`/org/branches/${branchId}/doctors/${sara.id}`);
    expect(offSara.status).toBe(409);
    expect(offSara.body.error.message).toContain('1');
    const removeBranch = await api(owner.auth).delete(`/org/branches/${branchId}`);
    expect(removeBranch.status).toBe(409);
    // A doctor with nothing booked there can go.
    expect((await api(owner.auth).delete(`/org/branches/${branchId}/doctors/${omar.id}`)).status).toBe(204);

    await BookingModel.updateOne({ _id: id }, { status: 'cancelled' });
    expect((await api(owner.auth).delete(`/org/branches/${branchId}/doctors/${sara.id}`)).status).toBe(204);
    expect((await api(owner.auth).delete(`/org/branches/${branchId}`)).status).toBe(204);
  });
});

describe('branch reception', () => {
  /** Invite + sign-up as reception through the real API. */
  const newReception = async () => {
    const phone = randomPhone();
    const invite = await api(owner.auth).post(`/org/branches/${branchId}/reception`, {
      phone,
      full_name: 'هالة',
    });
    expect(invite.status).toBe(201);
    const verified = await loginWithOtp(app, phone);
    expect(verified.staff_invites).toEqual([expect.objectContaining({ kind: 'reception', type: null })]);
    const registered = await request(app)
      .post('/api/v1/auth/register')
      .set('Authorization', `Bearer ${verified.registration_token}`)
      .send({
        role: 'reception',
        full_name: 'هالة محمود',
        gender: 'female',
        date_of_birth: '1995-05-05',
        staff_invite_id: invite.body.data.invite_id,
      });
    expect(registered.status).toBe(201);
    return {
      auth: `Bearer ${registered.body.data.access_token}`,
      userId: registered.body.data.user.id as string,
    };
  };

  it("sees only today's appointments at its branch — names and times, nothing medical or financial — and every view is audited", async () => {
    const reception = await newReception();
    const id = (await book(at('18:00'), { provider_id: sara.id })).body.data.id;
    await BookingModel.updateOne(
      { _id: id },
      { scheduledStart: new Date(), scheduledEnd: new Date(Date.now() + 20 * 60_000) },
    );
    const list = (await api(reception.auth).get('/reception/appointments')).body.data;
    expect(list).toEqual([
      expect.objectContaining({
        id,
        patient_name: expect.any(String),
        doctor: { id: sara.id, name: expect.any(String) },
        service_name: 'كشف',
        status: 'accepted',
        check_in: null,
        visit_code_locked: false,
        // Started just now: no-show only after the grace period.
        allowed_actions: ['check_in'],
      }),
    ]);
    expect(Object.keys(list[0]).sort()).toEqual(
      [
        'allowed_actions',
        'check_in',
        'doctor',
        'id',
        'patient_name',
        'reference_code',
        'scheduled_end',
        'scheduled_start',
        'service_name',
        'status',
        'visit_code_locked',
      ].sort(),
    );
    await BookingModel.updateOne(
      { _id: id },
      { scheduledStart: new Date(Date.now() - 20 * 60_000), visitCodeAttempts: 5 },
    );
    expect((await api(reception.auth).get('/reception/appointments')).body.data[0]).toMatchObject({
      visit_code_locked: true,
      allowed_actions: ['check_in', 'no_show'],
    });

    // GET /me names the branch the desk works at.
    const me = (await api(reception.auth).get('/me')).body.data;
    expect(me.reception).toEqual({
      organization: { id: owner.orgId, name: expect.any(String) },
      branch: { id: branchId, name: branchBody.name },
    });
    expect((await api(patient.auth).get('/me')).body.data.reception).toBeNull();
    expect(
      await AuditLogModel.exists({ action: 'reception.appointments_view', actorId: reception.userId }),
    ).toBeTruthy();
  });

  it('checks in with the visit code (starting the visit) or marks a no-show after the grace period; audited', async () => {
    const reception = await newReception();
    const id = (await book(at('18:00'), { provider_id: sara.id })).body.data.id;
    const code = (await BookingModel.findById(id).lean())!.visitCode!;
    const wrong = code === '0000' ? '1111' : '0000';
    expect(
      (await api(reception.auth).post(`/reception/appointments/${id}/check-in`, { visit_code: wrong }))
        .status,
    ).toBe(422);
    await api(reception.auth)
      .post(`/reception/appointments/${id}/check-in`, { visit_code: code })
      .expect(204);
    expect((await BookingModel.findById(id).lean())!).toMatchObject({
      status: 'in_progress',
      checkIn: { method: 'code' },
    });
    expect(await AuditLogModel.exists({ action: 'reception.check_in', entityId: id })).toBeTruthy();

    const other = await world.newPatient();
    const late = (await book(at('18:20'), { provider_id: omar.id }, other)).body.data.id;
    expect((await api(reception.auth).post(`/reception/appointments/${late}/no-show`)).status).toBe(409);
    await BookingModel.updateOne({ _id: late }, { scheduledStart: new Date(Date.now() - 20 * 60_000) });
    await api(reception.auth).post(`/reception/appointments/${late}/no-show`).expect(204);
    expect((await BookingModel.findById(late).lean())!.status).toBe('no_show');
  });

  it('can reach nothing else; another branch is out of reach; removal ends access at once', async () => {
    const reception = await newReception();
    for (const path of ['/org/bookings', '/provider/bookings', '/admin/dashboard', '/patient-profiles']) {
      expect((await api(reception.auth).get(path)).status, path).toBe(403);
    }
    // Patients, providers and owners can't use reception routes.
    for (const auth of [patient.auth, sara.auth, owner.auth]) {
      expect((await api(auth).get('/reception/appointments')).status).toBe(403);
    }
    // An appointment at another organization's branch.
    const other = await newOrg();
    const otherBranch = await ClinicModel.create({
      organizationId: other.orgId,
      name: 'فرع آخر',
      governorateId: world.cairo,
      areaId: world.nasrCity,
      street: 'شارع آخر',
      phone: '+20222224444',
      status: ClinicStatus.APPROVED,
    });
    const foreign = await BookingModel.findOneAndUpdate(
      {},
      { clinicId: otherBranch._id },
      { new: true },
    ).lean();
    if (foreign)
      expect((await api(reception.auth).post(`/reception/appointments/${foreign._id}/no-show`)).status).toBe(
        404,
      );

    await api(owner.auth).delete(`/org/branches/${branchId}/reception/${reception.userId}`).expect(204);
    expect((await api(reception.auth).get('/reception/appointments')).status).toBe(403);
    expect(
      await AuditLogModel.exists({ action: 'reception.remove', entityId: reception.userId }),
    ).toBeTruthy();
  });
});
