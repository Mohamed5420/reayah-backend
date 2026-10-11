import { Types } from 'mongoose';
import request from 'supertest';
import { Container } from 'typedi';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app';
import { useTestDatabase } from '../helpers/db';
import { createUserWithToken, loginWithOtp, randomPhone, signUp } from '../helpers/fixtures';
import { eventually } from '../helpers/notifications';
import { sampleFiles, useFakeStorage } from '../helpers/storage';
import {
  createBookingWorld,
  tomorrowAt,
  type BookingWorld,
  type TestPatient,
  type TestProvider,
} from '../helpers/booking-world';
import { BookingModel } from '../../src/database/models/booking/booking.model';
import { NotificationModel } from '../../src/database/models/notification/notification.model';
import {
  OrganizationDocumentModel,
  OrganizationModel,
} from '../../src/database/models/organization/organization.models';
import { ProviderProfileModel } from '../../src/database/models/provider/provider-profile.model';
import { Gender, UserRole, VerificationStatus } from '../../src/interfaces/enums';
import { StaffService } from '../../src/services/organization';
import { DocumentExpiryService } from '../../src/services/provider';
import { registerBookingNotifications } from '../../src/services/notification/booking-notifications';
import { addDays, cairoDate } from '../../src/utils/time/cairo';

/** Organizations (M21): reassignment reason, timed suspension, invite set-up and resend, licence pause, report columns. */

useTestDatabase();
useFakeStorage();
const app = createTestApp();
registerBookingNotifications();

type Owner = { auth: string; userId: string; orgId: string };

let world: BookingWorld;
let patient: TestPatient;
let owner: Owner;
let sara: TestProvider;
let omar: TestProvider;

const api = (auth: string) => ({
  get: (path: string) => request(app).get(`/api/v1${path}`).set('Authorization', auth),
  post: (path: string, body?: object) =>
    request(app).post(`/api/v1${path}`).set('Authorization', auth).send(body),
  patch: (path: string, body: object) =>
    request(app).patch(`/api/v1${path}`).set('Authorization', auth).send(body),
});

const newOrg = async (): Promise<Owner> => {
  const session = await signUp(app, UserRole.OWNER);
  const org = await OrganizationModel.create({
    ownerUserId: session.user.id,
    name: 'مركز الشفاء للتمريض',
    type: 'nursing_center',
    commercialRegisterNo: String(Math.random()).slice(2, 10),
    taxId: '987-654-321',
    verificationStatus: VerificationStatus.APPROVED,
    serviceAreas: [{ areaId: world.nasrCity, travelFee: 3000, isActive: true }],
    services: [{ serviceId: world.wound, price: 30000, isActive: true }],
    commissionRate: 10,
  });
  return { auth: `Bearer ${session.access_token}`, userId: session.user.id, orgId: String(org._id) };
};
const newStaff = (gender: Gender) =>
  world.newProvider({
    gender,
    overrides: { organizationId: owner.orgId as never },
    userOverrides: { role: UserRole.PROVIDER_STAFF },
  });
/** An organization booking assigned to `who` at `start`. */
const assigned = async (who: TestProvider, start: string) => {
  const id = (
    await world.book(patient, { id: '' } as TestProvider, {
      provider_id: null,
      organization_id: owner.orgId,
      scheduled_start: start,
    })
  ).body.data.id as string;
  await api(owner.auth).post(`/org/bookings/${id}/assign`, { provider_profile_id: who.id }).expect(200);
  return id;
};
const inDays = (days: number, time = '10:00') =>
  new Date(new Date(tomorrowAt(time)).getTime() + (days - 1) * 24 * 3600_000).toISOString();

beforeEach(async () => {
  world = await createBookingWorld(app);
  patient = await world.newPatient();
  owner = await newOrg();
  sara = await newStaff(Gender.FEMALE);
  omar = await newStaff(Gender.MALE);
});

describe('reassignment', () => {
  it('the reason is internal: the new member and admins see it; the patient is told the provider changed', async () => {
    const id = await assigned(sara, tomorrowAt('10:00'));
    await api(owner.auth)
      .post(`/org/bookings/${id}/reassign`, {
        provider_profile_id: omar.id,
        reason_code: 'patient_request',
        reason_text: 'طلب المريض ممرضًا',
      })
      .expect(200);

    const detail = (await world.providerApi(omar, 'get', `/bookings/${id}`)).body.data;
    expect(detail.reassignment).toMatchObject({
      reason_code: 'patient_request',
      reason_text: 'طلب المريض ممرضًا',
    });
    const patientView = await api(patient.auth).get(`/bookings/${id}`);
    expect(JSON.stringify(patientView.body)).not.toContain('طلب المريض');

    const admin = await createUserWithToken(UserRole.ADMIN);
    const history = (await api(admin.auth).get(`/admin/bookings/${id}`)).body.data.history;
    expect(history.find((h: { note: string }) => h.note === 'reassigned').internal_reason).toEqual({
      code: 'patient_request',
      text: 'طلب المريض ممرضًا',
    });

    const events = await eventually(async () => {
      const list = await NotificationModel.find({ userId: patient.userId }).lean();
      expect(list.map((n) => n.data.event)).toContain('booking_provider_changed');
      return list.map((n) => n.data.event);
    });
    expect(events.filter((e) => e === 'booking_accepted')).toHaveLength(1); // the first assignment only
  });
});

describe('suspending a member', () => {
  it('with a reason and an end: their bookings in that period go back to the queue; it lifts by itself', async () => {
    const soon = await assigned(sara, tomorrowAt('10:00'));
    const later = await assigned(sara, inDays(6));
    const endsAt = inDays(3);

    expect((await api(owner.auth).patch(`/org/staff/${sara.id}`, { reason: 'إجازة' })).status).toBe(422);
    expect(
      (await api(owner.auth).patch(`/org/staff/${sara.id}`, { status: 'suspended', ends_at: inDays(100) }))
        .status,
    ).toBe(422);
    const res = await api(owner.auth).patch(`/org/staff/${sara.id}`, {
      status: 'suspended',
      reason: 'إجازة سنوية',
      ends_at: endsAt,
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      status: 'suspended',
      suspension: { reason: 'إجازة سنوية', ends_at: endsAt },
    });

    const back = (await BookingModel.findById(soon).lean())!;
    expect(back).toMatchObject({ status: 'pending', providerProfileId: null });
    expect(back.assignmentDeadline!.getTime()).toBeGreaterThan(Date.now());
    expect(String((await BookingModel.findById(later).lean())!.providerProfileId)).toBe(sara.id);
    expect(
      await NotificationModel.exists({
        userId: sara.userId,
        'data.event': 'staff_suspended',
        body: /إجازة سنوية/,
      }),
    ).toBeTruthy();

    await ProviderProfileModel.updateOne(
      { _id: sara.id },
      { staffSuspendedUntil: new Date(Date.now() - 1000) },
    );
    expect(await Container.get(StaffService).liftExpiredSuspensions()).toBe(1);
    expect((await api(owner.auth).get(`/org/staff/${sara.id}`)).body.data).toMatchObject({
      status: 'active',
      suspension: null,
    });
  });
});

describe('invites', () => {
  it('areas and services set on the invite are applied on joining; resend once an hour', async () => {
    const phone = randomPhone();
    const bad = await api(owner.auth).post('/org/staff/invite', {
      phone,
      full_name: 'منى',
      type: 'nurse',
      area_ids: [String(new Types.ObjectId())],
    });
    expect(bad.body.error.fields).toHaveProperty(['area_ids.0']);
    const invite = await api(owner.auth).post('/org/staff/invite', {
      phone,
      full_name: 'منى',
      type: 'nurse',
      area_ids: [world.nasrCity],
      service_ids: [world.wound],
    });
    expect(invite.status).toBe(201);
    expect(invite.body.data).toMatchObject({ area_ids: [world.nasrCity], service_ids: [world.wound] });

    const resent = await api(owner.auth).post(`/org/staff/invites/${invite.body.data.id}/resend`);
    expect(resent.status).toBe(200);
    expect(new Date(resent.body.data.expires_at).getTime()).toBeGreaterThan(
      new Date(invite.body.data.expires_at).getTime() - 1000,
    );
    expect((await api(owner.auth).post(`/org/staff/invites/${invite.body.data.id}/resend`)).status).toBe(429);

    const verified = await loginWithOtp(app, phone);
    const registered = await request(app)
      .post('/api/v1/auth/register')
      .set('Authorization', `Bearer ${verified.registration_token}`)
      .send({
        role: 'provider_staff',
        full_name: 'منى علي',
        gender: 'female',
        date_of_birth: '1992-02-02',
        staff_invite_id: invite.body.data.id,
      });
    expect(registered.status).toBe(201);
    const profile = (await ProviderProfileModel.findOne({ userId: registered.body.data.user.id }).lean())!;
    expect(profile.serviceAreas.map((a) => String(a.areaId))).toEqual([world.nasrCity]);
    expect(profile.services.map((s) => [String(s.serviceId), s.price])).toEqual([[world.wound, 30000]]);
  });
});

describe('organization details, documents and the activity licence', () => {
  const upload = async () =>
    (
      await request(app)
        .post('/api/v1/uploads')
        .set('Authorization', owner.auth)
        .field('purpose', 'org_document')
        .attach('file', sampleFiles.pdf, 'doc.pdf')
    ).body.data.file_key as string;
  const attach = async (body: object) =>
    api(owner.auth).post('/org/documents', { file_key: await upload(), ...body });

  it('place, manager, and document rules', async () => {
    expect(
      (await api(owner.auth).patch('/org', { governorate_id: world.cairo })).body.error.fields,
    ).toHaveProperty('area_id');
    const moved = await api(owner.auth).patch('/org', {
      governorate_id: world.cairo,
      area_id: world.maadi,
      manager_name: 'أحمد سمير',
      email: 'info@example.com',
    });
    expect(moved.body.data).toMatchObject({
      area: { id: world.maadi },
      manager_name: 'أحمد سمير',
      email: 'info@example.com',
    });

    const missing = await attach({ type: 'activity_licence' });
    expect(Object.keys(missing.body.error.fields).sort()).toEqual(['expires_at', 'issuing_authority']);
    expect((await attach({ type: 'tax_card', issuing_authority: 'other' })).status).toBe(422);
    const manager = await attach({ type: 'manager_id', back_file_key: await upload() });
    expect(manager.body.data.back_file_url).toEqual(expect.any(String));
  });

  it('an expired activity licence pauses the organization until a valid one is approved', async () => {
    await OrganizationDocumentModel.create({
      organizationId: owner.orgId,
      type: 'activity_licence',
      fileKey: 'organization-documents/x/old.pdf',
      mime: 'application/pdf',
      issuingAuthority: 'ministry_of_health',
      status: 'matching',
      expiresAt: new Date(Date.now() - 1000),
    });
    await Container.get(DocumentExpiryService).processDaily();
    expect((await api(owner.auth).get('/org')).body.data.paused).toMatchObject({
      reason: 'activity_licence_expired',
    });
    const search = await api(patient.auth).get(
      `/providers?service_id=${world.wound}&area_id=${world.nasrCity}`,
    );
    expect(search.body.data.map((c: { id: string }) => c.id)).not.toContain(owner.orgId);

    const renewed = await attach({
      type: 'activity_licence',
      issuing_authority: 'ministry_of_health',
      expires_at: '2030-12-31',
    });
    const admin = await createUserWithToken(UserRole.ADMIN);
    await api(admin.auth)
      .post(`/admin/documents/${renewed.body.data.id}/review`, { status: 'matching' })
      .expect(200);
    expect((await api(owner.auth).get('/org')).body.data.paused).toBeNull();
  });
});

describe('reports', () => {
  it('rows and summary carry commission and net', async () => {
    const id = await assigned(sara, tomorrowAt('10:00'));
    for (const step of ['on-the-way', 'start', 'complete']) {
      await world.providerApi(sara, 'post', `/bookings/${id}/${step}`).expect(200);
    }
    const done = (await BookingModel.findById(id).lean())!;
    const day = addDays(cairoDate(), 1);
    const report = (await api(owner.auth).get(`/org/reports?from=${day}&to=${day}&group_by=staff`)).body.data;
    expect(report.rows[0]).toMatchObject({
      key: sara.id,
      commission: done.price.commissionAmount,
      net: done.price.providerPayout,
    });
    expect(report.summary).toMatchObject({
      commission: done.price.commissionAmount,
      net: done.price.providerPayout,
    });
  });
});
