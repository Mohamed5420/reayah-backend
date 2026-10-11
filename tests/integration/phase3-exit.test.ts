import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { Container } from 'typedi';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app';
import { useTestDatabase } from '../helpers/db';
import { createUserWithToken, loginWithOtp, randomPhone, signUp } from '../helpers/fixtures';
import { clearQueuedPushes, eventually, queuedPushes } from '../helpers/notifications';
import { fakeBucket, sampleFiles, useFakeStorage } from '../helpers/storage';
import { createBookingWorld, tomorrowAt, type TestProvider } from '../helpers/booking-world';
import { BookingModel } from '../../src/database/models/booking/booking.model';
import { WalletLedgerModel } from '../../src/database/models/ledger/wallet.model';
import { ProviderProfileModel } from '../../src/database/models/provider/provider-profile.model';
import { UserRole, VerificationStatus } from '../../src/interfaces/enums';
import { registerBookingNotifications } from '../../src/services/notification/booking-notifications';
import { StatementService, monthRange, previousMonth } from '../../src/services/organization';
import { cairoDate } from '../../src/utils/time/cairo';

/**
 * Phase 3 exit (BUILD_PLAN): an organization onboards, invites staff, receives a booking, assigns or
 * broadcasts it, and sees it in reports and invoices; an unassigned booking falls back to other
 * providers after the deadline.
 *
 * "مركز الشفاء" (Nasr City, wound dressing 300 EGP + 30 EGP travel, 10% commission = 30 EGP) gets:
 *   A. 09:00 — the owner assigns Mona (staff)          → completed; the organization owes 30
 *   B. 11:00 — the owner sends it to all staff; Mona accepts → completed; the organization owes 30
 *   C. 13:00 — nobody assigns it; after the deadline it goes to an independent nurse, who completes it
 *              (hers alone: not in the organization's reports, ledger or statement)
 * Reports / earnings: 2 visits, 660 gross, 60 commission. Statement for the month of the visits: 2 visits, 60.
 */

useTestDatabase();
useFakeStorage();
const app = createTestApp();
registerBookingNotifications();

let admin: Awaited<ReturnType<typeof createUserWithToken>>;

beforeEach(async () => {
  admin = await createUserWithToken(UserRole.ADMIN);
  clearQueuedPushes();
});

const api = (auth: string) => ({
  get: (path: string) => request(app).get(`/api/v1${path}`).set('Authorization', auth),
  post: (path: string, body?: object) =>
    request(app)
      .post(`/api/v1${path}`)
      .set('Authorization', auth)
      .set('Idempotency-Key', randomUUID())
      .send(body),
  put: (path: string, body: object) =>
    request(app).put(`/api/v1${path}`).set('Authorization', auth).send(body),
  patch: (path: string, body: object) =>
    request(app).patch(`/api/v1${path}`).set('Authorization', auth).send(body),
});

const upload = async (auth: string, purpose: string) => {
  const res = await request(app)
    .post('/api/v1/uploads')
    .set('Authorization', auth)
    .field('purpose', purpose)
    .attach('file', sampleFiles.pdf, 'doc.pdf');
  expect(res.status).toBe(201);
  return res.body.data.file_key as string;
};

describe('Phase 3 exit', () => {
  it('an organization onboards, builds a team, assigns, broadcasts, falls back and is billed', async () => {
    const world = await createBookingWorld(app);
    const patientA = await world.newPatient();
    const patientB = await world.newPatient();
    const patientC = await world.newPatient();

    // 1. Onboarding: the owner signs up, sets the organization up and submits; an admin approves it.
    const session = await signUp(app, UserRole.OWNER);
    const owner = { auth: `Bearer ${session.access_token}`, userId: session.user.id as string };
    const created = await api(owner.auth).post('/org', {
      name: 'مركز الشفاء للتمريض',
      type: 'nursing_center',
      commercial_register_no: '123456',
      tax_id: '987-654-321',
      phone: '+20222223333',
      address_text: '12 شارع مكرم عبيد، مدينة نصر',
      governorate_id: world.cairo,
      area_id: world.nasrCity,
      manager_name: 'أحمد سمير',
    });
    expect(created.status).toBe(201);
    const orgId: string = created.body.data.id;
    for (const type of ['commercial_register', 'tax_card', 'activity_licence', 'manager_id']) {
      await api(owner.auth)
        .post('/org/documents', {
          type,
          file_key: await upload(owner.auth, 'org_document'),
          ...(type === 'activity_licence'
            ? { issuing_authority: 'ministry_of_social_solidarity', expires_at: '2030-12-31' }
            : {}),
        })
        .expect(201);
    }
    await api(owner.auth)
      .put('/org/service-areas', { areas: [{ area_id: world.nasrCity, travel_fee: 3000 }] })
      .expect(200);
    await api(owner.auth)
      .put('/org/services', { services: [{ service_id: world.wound, price: 30000 }] })
      .expect(200);
    expect((await api(owner.auth).post('/org/submit-verification')).body.data.verification_status).toBe(
      'pending',
    );
    const queue = await api(admin.auth).get('/admin/verifications?type=organization');
    expect(queue.body.data).toEqual([expect.objectContaining({ id: orgId, status: 'pending' })]);
    await api(admin.auth).patch(`/admin/organizations/${orgId}`, { commission_rate: 10 }).expect(200);
    const approved = await api(admin.auth).post(`/admin/verifications/${orgId}/approve`);
    expect(approved.body.data.verification_status).toBe('approved');

    // 2. Team: the owner invites a new number, who signs up with the invite and is verified.
    const staffPhone = randomPhone();
    const invite = await api(owner.auth).post('/org/staff/invite', {
      phone: staffPhone,
      full_name: 'منى سعيد',
      type: 'nurse',
    });
    expect(invite.status).toBe(201);
    const verified = await loginWithOtp(app, staffPhone);
    const registered = await request(app)
      .post('/api/v1/auth/register')
      .set('Authorization', `Bearer ${verified.registration_token}`)
      .send({
        role: 'provider_staff',
        staff_invite_id: invite.body.data.id,
        full_name: 'منى سعيد',
        gender: 'female',
        date_of_birth: '1995-05-01',
      });
    expect(registered.status).toBe(201);
    const monaProfile = (await ProviderProfileModel.findOne({
      userId: registered.body.data.user.id,
    }).lean())!;
    const mona = {
      id: String(monaProfile._id),
      auth: `Bearer ${registered.body.data.access_token}`,
    } as TestProvider;
    expect(String(monaProfile.organizationId)).toBe(orgId);
    // Staff verification (provider documents) is covered in provider tests; approve directly as staff.test does.
    await ProviderProfileModel.updateOne(
      { _id: mona.id },
      { verificationStatus: VerificationStatus.APPROVED, isAcceptingBookings: true },
    );
    await api(owner.auth)
      .patch(`/org/staff/${mona.id}`, { service_ids: [world.wound] })
      .expect(200);
    await api(owner.auth)
      .put(`/org/staff/${mona.id}/service-areas`, { area_ids: [world.nasrCity] })
      .expect(200);
    await api(owner.auth)
      .put(`/org/staff/${mona.id}/availability`, {
        slots: [0, 1, 2, 3, 4, 5, 6].map((day) => ({
          day_of_week: day,
          start_time: '08:00',
          end_time: '20:00',
        })),
      })
      .expect(200);
    expect((await api(owner.auth).get('/org/staff')).body.data).toEqual([
      expect.objectContaining({ id: mona.id, full_name: 'منى سعيد', status: 'active' }),
    ]);

    const bookOrg = async (patient: typeof patientA, at: string) => {
      const res = await world.book(patient, { id: '' } as TestProvider, {
        provider_id: null,
        organization_id: orgId,
        scheduled_start: at,
      });
      expect(res.status).toBe(201);
      return res.body.data.id as string;
    };
    const visit = async (who: TestProvider, id: string) => {
      for (const step of ['on-the-way', 'start', 'complete']) {
        await world.providerApi(who, 'post', `/bookings/${id}/${step}`).expect(200);
      }
    };

    // 3. Booking A: the owner assigns Mona (accepted at once); she does the visit.
    const a = await bookOrg(patientA, tomorrowAt('09:00'));
    expect((await api(owner.auth).get('/org/bookings?status=pending')).body.data).toEqual([
      expect.objectContaining({ id: a, allowed_actions: ['assign', 'broadcast', 'decline'] }),
    ]);
    const assigned = await api(owner.auth).post(`/org/bookings/${a}/assign`, {
      provider_profile_id: mona.id,
    });
    expect(assigned.body.data).toMatchObject({ status: 'accepted', staff: { id: mona.id } });
    await visit(mona, a);

    // 4. Booking B: the owner sends it to all suitable staff; Mona accepts the offer.
    const b = await bookOrg(patientB, tomorrowAt('11:00'));
    expect((await api(owner.auth).post(`/org/bookings/${b}/broadcast`)).body.data).toEqual({ offered: 1 });
    const [offerB] = (await world.providerApi(mona, 'get', '/offers')).body.data;
    await world.providerApi(mona, 'post', `/offers/${offerB.id}/accept`).expect(200);
    expect(String((await BookingModel.findById(b).lean())!.providerProfileId)).toBe(mona.id);
    await visit(mona, b);

    // 5. Booking C: left in the queue; after the deadline it falls back to an independent nurse.
    const c = await bookOrg(patientC, tomorrowAt('13:00'));
    const dashboard = await api(owner.auth).get('/org/dashboard?period=month');
    expect(dashboard.body.data.bookings.unassigned).toBe(1);
    expect(dashboard.body.data.alerts).toEqual([
      expect.objectContaining({ type: 'unassigned_booking', booking_id: c }),
    ]);
    const independent = await world.newProvider();
    await world.passDeadline(c);
    expect((await BookingModel.findById(c).lean())!).toMatchObject({
      assignmentMode: 'broadcast',
      providerProfileId: null,
    });
    const late = await api(owner.auth).post(`/org/bookings/${c}/assign`, { provider_profile_id: mona.id });
    expect(late.body.error.code).toBe('ASSIGNMENT_DEADLINE_PASSED');
    const [offerC] = (await world.providerApi(independent, 'get', '/offers')).body.data;
    expect(offerC).toBeDefined();
    await world.providerApi(independent, 'post', `/offers/${offerC.id}/accept`).expect(200);
    const taken = (await BookingModel.findById(c).lean())!;
    expect(String(taken.providerProfileId)).toBe(independent.id);
    expect(taken.organizationId).toBeNull();
    expect((await api(owner.auth).get(`/org/bookings/${c}`)).status).toBe(404);
    await eventually(() =>
      expect(queuedPushes().some((p) => p.userId === patientC.userId && p.data.status === 'accepted')).toBe(
        true,
      ),
    );
    await visit(independent, c);

    // 6. The owner's view: the two team visits, and none of the independent's.
    const ledger = await WalletLedgerModel.find({ ownerType: 'organization', ownerId: orgId })
      .sort({ _id: 1 })
      .lean();
    expect(ledger.map((e) => [String(e.bookingId), e.type, e.amount])).toEqual([
      [a, 'commission_due', -3000],
      [b, 'commission_due', -3000],
    ]);
    const earnings = await api(owner.auth).get(`/org/earnings?from=${cairoDate()}&to=${cairoDate()}`);
    expect(earnings.body.data).toMatchObject({
      completed_visits: 2,
      gross: 66000,
      commission: 6000,
      net: 60000,
      commission_due: 6000,
    });
    const day = tomorrowAt('09:00').slice(0, 10);
    const report = await api(owner.auth).get(`/org/reports?from=${day}&to=${day}&group_by=staff`);
    expect(report.body.data.summary).toMatchObject({ visits: 2, revenue: 66000 });
    expect(report.body.data.rows).toEqual([
      expect.objectContaining({ key: mona.id, label: 'منى سعيد', visits: 2, revenue: 66000 }),
    ]);

    // Invoices: the monthly statement. As in org-finance.test, the visits are moved into last month so a
    // statement can be closed for them now (C too, to show it stays off the organization's statement).
    const lastMonth = new Date(monthRange(previousMonth()).from.getTime() + 14 * 864e5);
    await BookingModel.updateMany({ _id: { $in: [a, b, c] } }, { completedAt: lastMonth });
    expect(await Container.get(StatementService).generate(previousMonth())).toBe(1);
    const [statement] = (await api(owner.auth).get('/org/invoices')).body.data;
    expect(statement).toMatchObject({
      period: previousMonth(),
      kind: 'statement',
      visits: 2,
      commission: 6000,
      subscription_fees: 0,
      total: 6000,
    });
    const pdf = await api(owner.auth).get(`/org/invoices/${statement.id}/pdf`);
    expect(pdf.body.data.url).toContain('org-statements/');
    const stored = [...fakeBucket.entries()].find(([key]) => key.startsWith('org-statements/'))!;
    expect(stored[1].body.subarray(0, 4).toString()).toBe('%PDF');
  });
});
