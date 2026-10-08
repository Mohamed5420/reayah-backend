import mongoose from 'mongoose';
import request from 'supertest';
import { Container } from 'typedi';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app';
import { useTestDatabase } from '../helpers/db';
import { loginWithOtp, randomPhone, signUp } from '../helpers/fixtures';
import { clearQueuedPushes, eventually, queuedPushes } from '../helpers/notifications';
import { createBookingWorld, type BookingWorld } from '../helpers/booking-world';
import {
  OrganizationModel,
  StaffInviteModel,
} from '../../src/database/models/organization/organization.models';
import { ProviderProfileModel } from '../../src/database/models/provider/provider-profile.model';
import { UserModel } from '../../src/database/models/user/user.model';
import { withTransaction } from '../../src/database/transaction';
import { UserRole, VerificationStatus } from '../../src/interfaces/enums';
import { LedgerEntryType, LedgerOwnerType } from '../../src/interfaces/ILedger';
import { LedgerService } from '../../src/services/ledger/ledger.service';

/** M3.2: team management — invites, joining, the owner's staff controls, removal. */

useTestDatabase();
const app = createTestApp();

let world: BookingWorld;
let owner: { auth: string; userId: string };
let orgId: string;

const api = (auth: string) => ({
  get: (path: string) => request(app).get(`/api/v1${path}`).set('Authorization', auth),
  post: (path: string, body?: object) =>
    request(app).post(`/api/v1${path}`).set('Authorization', auth).send(body),
  put: (path: string, body: object) =>
    request(app).put(`/api/v1${path}`).set('Authorization', auth).send(body),
  patch: (path: string, body: object) =>
    request(app).patch(`/api/v1${path}`).set('Authorization', auth).send(body),
  delete: (path: string) => request(app).delete(`/api/v1${path}`).set('Authorization', auth),
});

/** An owner with an approved organization serving Nasr City (30 EGP) and wound dressing (300 EGP). */
const approvedOrg = async (overrides: object = {}) => {
  const session = await signUp(app, UserRole.OWNER);
  const who = { auth: `Bearer ${session.access_token}`, userId: session.user.id as string };
  const org = await OrganizationModel.create({
    ownerUserId: who.userId,
    name: 'مركز الشفاء للتمريض',
    type: 'nursing_center',
    commercialRegisterNo: String(Math.random()).slice(2, 10),
    taxId: '987-654-321',
    verificationStatus: VerificationStatus.APPROVED,
    serviceAreas: [{ areaId: world.nasrCity, travelFee: 3000, isActive: true }],
    services: [{ serviceId: world.wound, price: 30000, isActive: true }],
    ...overrides,
  });
  return { ...who, orgId: String(org._id) };
};

/** A new number invited, then signed up with the invite. */
const joinAsNewStaff = async (name = 'سارة أحمد') => {
  const phone = randomPhone();
  const invite = await api(owner.auth).post('/org/staff/invite', { phone, full_name: name, type: 'nurse' });
  expect(invite.status).toBe(201);
  const verified = await loginWithOtp(app, phone);
  expect(verified.staff_invites).toEqual([
    { id: invite.body.data.id, organization_name: 'مركز الشفاء للتمريض', type: 'nurse' },
  ]);
  const registered = await request(app)
    .post('/api/v1/auth/register')
    .set('Authorization', `Bearer ${verified.registration_token}`)
    .send({
      role: 'provider_staff',
      staff_invite_id: invite.body.data.id,
      full_name: name,
      gender: 'female',
      date_of_birth: '1995-05-01',
    });
  expect(registered.status).toBe(201);
  const userId: string = registered.body.data.user.id;
  const profile = (await ProviderProfileModel.findOne({ userId }).lean())!;
  return {
    auth: `Bearer ${registered.body.data.access_token}`,
    userId,
    profileId: String(profile._id),
    phone,
  };
};

const approve = (profileId: string) =>
  ProviderProfileModel.updateOne(
    { _id: profileId },
    { verificationStatus: VerificationStatus.APPROVED, isAcceptingBookings: true },
  );

beforeEach(async () => {
  world = await createBookingWorld(app);
  ({ orgId, ...owner } = await approvedOrg());
  clearQueuedPushes();
});

describe('invites', () => {
  it('a new number signs up with the invite and joins as unverified staff', async () => {
    const staff = await joinAsNewStaff();
    expect((await UserModel.findById(staff.userId).lean())!.role).toBe('provider_staff');
    const profile = await ProviderProfileModel.findById(staff.profileId).lean();
    expect(profile).toMatchObject({ type: 'nurse', verificationStatus: 'draft' });
    expect(String(profile!.organizationId)).toBe(orgId);
    await eventually(() =>
      expect(queuedPushes().some((p) => p.userId === owner.userId && p.title === 'عضو جديد في الفريق')).toBe(
        true,
      ),
    );

    const team = await api(owner.auth).get('/org/staff');
    expect(team.body.data).toEqual([
      expect.objectContaining({
        id: staff.profileId,
        full_name: 'سارة أحمد',
        status: 'pending_verification',
      }),
    ]);
    expect((await api(owner.auth).get('/org/staff/invites')).body.data).toEqual([]); // used

    // Their verification checklist: profile + documents only (the owner sets areas, services, hours).
    const onboarding = (await api(staff.auth).get('/provider/profile')).body.data.onboarding;
    expect(onboarding).toMatchObject({ areas_selected: true, services_set: true, availability_set: true });
  });

  it('provider_staff sign-up needs a valid invite for that number; invites can be revoked', async () => {
    const verified = await loginWithOtp(app, randomPhone());
    const noInvite = await request(app)
      .post('/api/v1/auth/register')
      .set('Authorization', `Bearer ${verified.registration_token}`)
      .send({ role: 'provider_staff', full_name: 'منى', gender: 'female', date_of_birth: '1990-01-01' });
    expect(noInvite.status).toBe(422);

    const invite = await api(owner.auth).post('/org/staff/invite', {
      phone: randomPhone(),
      full_name: 'منى',
      type: 'nurse',
    });
    const someoneElse = await request(app)
      .post('/api/v1/auth/register')
      .set('Authorization', `Bearer ${verified.registration_token}`)
      .send({
        role: 'provider_staff',
        staff_invite_id: invite.body.data.id,
        full_name: 'منى',
        gender: 'female',
        date_of_birth: '1990-01-01',
      });
    expect(someoneElse.status).toBe(404); // the invite is for another number

    expect((await api(owner.auth).get('/org/staff/invites')).body.data).toHaveLength(1);
    expect((await api(owner.auth).delete(`/org/staff/invites/${invite.body.data.id}`)).status).toBe(204);
    expect((await api(owner.auth).get('/org/staff/invites')).body.data).toEqual([]);
  });

  it('only approved organizations invite; patients and other owners can’t be invited', async () => {
    const draft = await approvedOrg({ verificationStatus: VerificationStatus.DRAFT });
    expect(
      (
        await api(draft.auth).post('/org/staff/invite', {
          phone: randomPhone(),
          full_name: 'منى',
          type: 'nurse',
        })
      ).status,
    ).toBe(409);

    const patient = await world.newPatient();
    const res = await api(owner.auth).post('/org/staff/invite', {
      phone: patient.phone,
      full_name: 'أحمد',
      type: 'nurse',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe(
      'لا يمكن دعوة هذا الرقم؛ يمكن دعوة الأرقام الجديدة أو مقدمي الخدمة المستقلين فقط',
    );
  });

  it('an independent provider accepts in the app — only with no active bookings and a zero balance', async () => {
    const provider = await world.newProvider();
    const phone = provider.user.phone;
    const invite = await api(owner.auth).post('/org/staff/invite', {
      phone,
      full_name: 'منى حسن',
      type: 'nurse',
    });
    expect(invite.status).toBe(201);
    await eventually(() =>
      expect(
        queuedPushes().some((p) => p.userId === provider.userId && p.title === 'دعوة للانضمام لفريق'),
      ).toBe(true),
    );
    const received = await api(provider.auth).get('/provider/staff-invites');
    expect(received.body.data).toEqual([
      expect.objectContaining({ id: invite.body.data.id, organization_name: 'مركز الشفاء للتمريض' }),
    ]);

    // Active booking → refused.
    const patient = await world.newPatient();
    const booked = await world.book(patient, provider);
    expect(
      (await api(provider.auth).post(`/provider/staff-invites/${invite.body.data.id}/accept`)).status,
    ).toBe(409);
    await api(patient.auth).post(`/bookings/${booked.body.data.id}/cancel`, { reason_code: 'changed_mind' });

    // Money owed either way → refused.
    await withTransaction((session) =>
      Container.get(LedgerService).record(
        {
          ownerType: LedgerOwnerType.PROVIDER,
          ownerId: new mongoose.Types.ObjectId(provider.id),
          bookingId: null,
          type: LedgerEntryType.COMMISSION_DUE,
          amount: -3750,
          note: 'test',
        },
        session,
      ),
    );
    const owing = await api(provider.auth).post(`/provider/staff-invites/${invite.body.data.id}/accept`);
    expect(owing.body.error.message).toBe('يجب تسوية رصيدك وصرف المستحقات أولاً قبل الانضمام لمؤسسة');
    await withTransaction((session) =>
      Container.get(LedgerService).record(
        {
          ownerType: LedgerOwnerType.PROVIDER,
          ownerId: new mongoose.Types.ObjectId(provider.id),
          bookingId: null,
          type: LedgerEntryType.COMMISSION_PAYMENT,
          amount: 3750,
          note: 'test',
        },
        session,
      ),
    );

    expect(
      (await api(provider.auth).post(`/provider/staff-invites/${invite.body.data.id}/accept`)).status,
    ).toBe(204);
    // The role switch applies at once (same token).
    expect((await api(provider.auth).get('/me')).body.data.role).toBe('provider_staff');
    const profile = await ProviderProfileModel.findById(provider.id).lean();
    expect(profile).toMatchObject({
      verificationStatus: 'approved',
      serviceAreas: [],
      services: [],
      isAcceptingBookings: false,
    });
    expect(String(profile!.organizationId)).toBe(orgId);
    // Staff can't set their own areas or prices.
    expect((await api(provider.auth).put('/provider/service-areas', { areas: [] })).status).toBe(403);
  });
});

describe('the team', () => {
  it('owner sets services, areas and hours from the organization’s; staff never appear as independents', async () => {
    const staff = await joinAsNewStaff();
    const badServices = await api(owner.auth).patch(`/org/staff/${staff.profileId}`, {
      service_ids: [owner.userId],
    });
    expect(badServices.body.error.fields).toHaveProperty(['service_ids.0']);
    const badAreas = await api(owner.auth).put(`/org/staff/${staff.profileId}/service-areas`, {
      area_ids: [world.maadi],
    });
    expect(badAreas.body.error.fields['area_ids.0']).toEqual(['المؤسسة لا تغطي هذه المنطقة']);

    await api(owner.auth)
      .patch(`/org/staff/${staff.profileId}`, { service_ids: [world.wound] })
      .expect(200);
    await api(owner.auth)
      .put(`/org/staff/${staff.profileId}/service-areas`, { area_ids: [world.nasrCity] })
      .expect(200);
    const detail = await api(owner.auth).put(`/org/staff/${staff.profileId}/availability`, {
      slots: [{ day_of_week: 0, start_time: '09:00', end_time: '17:00' }],
    });
    expect(detail.body.data).toMatchObject({
      services: [expect.objectContaining({ service_id: world.wound, price: 30000 })],
      service_areas: [expect.objectContaining({ area_id: world.nasrCity, travel_fee: 3000 })],
      availability: [{ day_of_week: 0, start_time: '09:00', end_time: '17:00' }],
      performance: { completed_visits: 0, completed_last_30_days: 0, on_time_rate: null },
    });

    await approve(staff.profileId);
    expect((await api(owner.auth).get('/org/service-areas')).body.data[0].team_size).toBe(1);

    // Booked through the organization (M3.3), never directly.
    const patient = await world.newPatient();
    const search = await api(patient.auth).get(
      `/providers?service_id=${world.wound}&area_id=${world.nasrCity}`,
    );
    expect(search.body.data.map((p: { id: string }) => p.id)).not.toContain(staff.profileId);
    const quote = await world.quote(patient, { id: staff.profileId } as never);
    expect(quote.status).toBe(404);
  });

  it('suspend and reactivate within the organization', async () => {
    const staff = await joinAsNewStaff();
    await approve(staff.profileId);
    await api(owner.auth)
      .put(`/org/staff/${staff.profileId}/service-areas`, { area_ids: [world.nasrCity] })
      .expect(200);
    const suspended = await api(owner.auth).patch(`/org/staff/${staff.profileId}`, { status: 'suspended' });
    expect(suspended.body.data).toMatchObject({ status: 'suspended', is_accepting_bookings: false });
    expect((await api(owner.auth).get('/org/service-areas')).body.data[0].team_size).toBe(0);
    expect((await api(owner.auth).get('/org/staff?status=suspended')).body.data).toHaveLength(1);
    await eventually(() =>
      expect(queuedPushes().some((p) => p.userId === staff.userId && p.title === 'تم إيقافك مؤقتاً')).toBe(
        true,
      ),
    );
    const active = await api(owner.auth).patch(`/org/staff/${staff.profileId}`, { status: 'active' });
    expect(active.body.data.status).toBe('active');
  });

  it('removal: always allowed; they become an independent provider, verification kept, not accepting', async () => {
    const staff = await joinAsNewStaff();
    await approve(staff.profileId);
    await api(owner.auth)
      .patch(`/org/staff/${staff.profileId}`, { service_ids: [world.wound] })
      .expect(200);

    expect((await api(owner.auth).delete(`/org/staff/${staff.profileId}`)).status).toBe(204);
    const profile = await ProviderProfileModel.findById(staff.profileId).lean();
    expect(profile).toMatchObject({
      organizationId: null,
      verificationStatus: 'approved',
      isAcceptingBookings: false,
      services: [],
      serviceAreas: [],
    });
    expect((await api(staff.auth).get('/me')).body.data.role).toBe('provider');
    expect((await api(owner.auth).get(`/org/staff/${staff.profileId}`)).status).toBe(404);
    await eventually(() =>
      expect(
        queuedPushes().some((p) => p.userId === staff.userId && p.title === 'تمت إزالتك من الفريق'),
      ).toBe(true),
    );
    // Now independent: they can set their own areas.
    expect(
      (
        await api(staff.auth).put('/provider/service-areas', {
          areas: [{ area_id: world.nasrCity, travel_fee: 2000 }],
        })
      ).status,
    ).toBe(200);
  });

  it('another organization’s staff are out of reach', async () => {
    const staff = await joinAsNewStaff();
    const other = await approvedOrg();
    expect((await api(other.auth).get(`/org/staff/${staff.profileId}`)).status).toBe(404);
    expect((await api(other.auth).delete(`/org/staff/${staff.profileId}`)).status).toBe(404);
    expect((await api(other.auth).get('/org/staff')).body.data).toEqual([]);
    expect(await StaffInviteModel.countDocuments({ organizationId: other.orgId })).toBe(0);
  });
});
