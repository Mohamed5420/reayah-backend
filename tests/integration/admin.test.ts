import request from 'supertest';
import { Container } from 'typedi';
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
import { ProviderDocumentModel } from '../../src/database/models/provider/provider-document.model';
import { UserModel } from '../../src/database/models/user/user.model';
import { UserSuspensionModel } from '../../src/database/models/aftercare/aftercare.models';
import { WalletLedgerModel } from '../../src/database/models/ledger/wallet.model';
import { AuditLogModel } from '../../src/database/models/audit-log/audit-log.model';
import { UserRole, UserStatus, VerificationStatus } from '../../src/interfaces/enums';
import { DocumentReviewStatus, ProviderDocumentType } from '../../src/interfaces/IProvider';
import { AccountService } from '../../src/services/moderation';
import { DocumentExpiryService } from '../../src/services/provider';
import { registerBookingNotifications } from '../../src/services/notification/booking-notifications';

useTestDatabase();
const app = createTestApp();
registerBookingNotifications();

let world: BookingWorld;
let admin: Awaited<ReturnType<typeof createUserWithToken>>;
let patient: TestPatient;
let provider: TestProvider;

beforeEach(async () => {
  world = await createBookingWorld(app);
  admin = await createUserWithToken(UserRole.ADMIN);
  patient = await world.newPatient();
  provider = await world.newProvider();
  clearQueuedPushes();
});

const as = (auth: string) => ({
  get: (path: string) => request(app).get(`/api/v1${path}`).set('Authorization', auth),
  post: (path: string, body?: object) =>
    request(app).post(`/api/v1${path}`).set('Authorization', auth).send(body),
  patch: (path: string, body: object) =>
    request(app).patch(`/api/v1${path}`).set('Authorization', auth).send(body),
  put: (path: string, body: object) =>
    request(app).put(`/api/v1${path}`).set('Authorization', auth).send(body),
});

const bookAt = async (time: string, p = patient, prov = provider) => {
  const res = await world.book(p, prov, { scheduled_start: tomorrowAt(time) });
  expect(res.status).toBe(201);
  return res.body.data.id as string;
};
const accept = (id: string, prov = provider) => world.providerApi(prov, 'post', `/bookings/${id}/accept`);

describe('access', () => {
  it('admin routes are admins-only', async () => {
    for (const path of [
      '/admin/dashboard',
      '/admin/users',
      '/admin/bookings',
      '/admin/settings',
      '/admin/audit-logs',
    ]) {
      expect((await as(patient.auth).get(path)).status, path).toBe(403);
      expect((await request(app).get(`/api/v1${path}`)).status, path).toBe(401);
    }
  });
});

describe('users: suspend / warn / activate / history', () => {
  it('a timed suspension blocks the account, cancels its active bookings, and lifts itself', async () => {
    const booking = await bookAt('10:00');
    await accept(booking);
    clearQueuedPushes();

    const res = await as(admin.auth).post(`/admin/users/${patient.userId}/suspend`, {
      reason: 'إساءة لمقدم الخدمة',
      duration_days: 3,
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ cancelled_bookings: 1, ends_at: expect.any(String) });
    expect((await as(patient.auth).get('/me')).body.error.code).toBe('ACCOUNT_SUSPENDED');
    expect((await BookingModel.findById(booking).lean())!.status).toBe('cancelled');
    await eventually(() => {
      const users = queuedPushes().map((p) => p.userId);
      expect(users).toContain(patient.userId); // told why (in-app + push even while suspended)
      expect(users).toContain(provider.userId); // their visit was cancelled
    });

    // Not yet over → still suspended; once over → active again.
    const accounts = Container.get(AccountService);
    expect(await accounts.liftExpired()).toBe(0);
    expect(await accounts.liftExpired(new Date(Date.now() + 4 * 24 * 3600_000))).toBe(1);
    expect((await UserModel.findById(patient.userId).lean())!.status).toBe(UserStatus.ACTIVE);
    expect((await as(patient.auth).get('/me')).status).toBe(200);
  });

  it('a provider suspended until lifted stops taking bookings; activate restores the account', async () => {
    await as(admin.auth).post(`/admin/users/${provider.userId}/suspend`, {
      reason: 'شكاوى متكررة',
      duration_days: null,
      notify: false,
    });
    expect((await ProviderProfileModel.findById(provider.id).lean())!.isAcceptingBookings).toBe(false);
    expect(await Container.get(AccountService).liftExpired(new Date(Date.now() + 365 * 24 * 3600_000))).toBe(
      0,
    );

    const activated = await as(admin.auth).post(`/admin/users/${provider.userId}/activate`);
    expect(activated.body.data.status).toBe(UserStatus.ACTIVE);
    expect((await as(admin.auth).post(`/admin/users/${provider.userId}/activate`)).status).toBe(409);
    expect(await UserSuspensionModel.countDocuments({ userId: provider.userId, liftedAt: null })).toBe(0);
  });

  it('warnings, history and the self-suspension guard', async () => {
    const warned = await as(admin.auth).post(`/admin/users/${provider.userId}/warn`, {
      reason: 'التأخير عن المواعيد',
      related_type: 'booking',
    });
    expect(warned.status).toBe(201);
    await eventually(() => expect(queuedPushes().some((p) => p.data.type === 'account')).toBe(true));

    const history = await as(admin.auth).get(`/admin/users/${provider.userId}/history`);
    expect(history.body.data.warnings).toEqual([expect.objectContaining({ reason: 'التأخير عن المواعيد' })]);
    expect(history.body.data.audit_trail.map((e: { action: string }) => e.action)).toContain('user.warn');

    const self = await as(admin.auth).post(`/admin/users/${admin.id}/suspend`, {
      reason: 'test test',
      duration_days: 1,
    });
    expect(self.status).toBe(409);
  });

  it('lists and finds users', async () => {
    const found = await as(admin.auth).get(
      `/admin/users?role=patient&search=${encodeURIComponent(patient.phone.slice(-6))}`,
    );
    expect(found.body.data.map((u: { id: string }) => u.id)).toEqual([patient.userId]);
    const detail = await as(admin.auth).get(`/admin/users/${provider.userId}`);
    expect(detail.body.data.provider_profile).toMatchObject({
      id: provider.id,
      verification_status: 'approved',
    });
  });
});

describe('providers', () => {
  it('suspending the listing stops bookings and cancels active ones; restoring re-approves', async () => {
    const booking = await bookAt('10:00');
    await accept(booking);
    const profile = await ProviderProfileModel.findById(provider.id);
    profile!.licenseNumber = 'LIC-12345';
    await profile!.save();

    const res = await as(admin.auth).patch(`/admin/providers/${provider.id}`, {
      verification_status: 'suspended',
      admin_message: 'برجاء تحديث الترخيص',
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ verification_status: 'suspended', is_accepting_bookings: false });
    expect(res.body.data.license_number).toBe('LIC-12345'); // decrypted for admins
    expect((await BookingModel.findById(booking).lean())!.status).toBe('cancelled');

    expect(
      (await as(admin.auth).patch(`/admin/providers/${provider.id}`, { verification_status: 'approved' }))
        .status,
    ).toBe(200);
    const list = await as(admin.auth).get('/admin/providers?verification_status=approved');
    expect(list.body.data.map((p: { id: string }) => p.id)).toContain(provider.id);
  });
});

describe('bookings', () => {
  it('lists, finds by reference and shows the timeline', async () => {
    const id = await bookAt('10:00');
    const ref = (await BookingModel.findById(id).lean())!.referenceCode;
    const list = await as(admin.auth).get(`/admin/bookings?search=${ref.slice(-4)}&status=pending`);
    expect(list.body.data.map((b: { id: string }) => b.id)).toEqual([id]);
    const detail = await as(admin.auth).get(`/admin/bookings/${id}`);
    expect(detail.body.data.history).toEqual([expect.objectContaining({ to_status: 'pending' })]);
  });

  it('force-completing a started visit records the commission like a provider completion', async () => {
    const id = await bookAt('10:00');
    await accept(id);
    expect((await as(admin.auth).post(`/admin/bookings/${id}/status`, { status: 'disputed' })).status).toBe(
      422,
    );
    // A visit that never started can't be completed — cancel or record a no-show instead.
    expect((await as(admin.auth).post(`/admin/bookings/${id}/status`, { status: 'completed' })).status).toBe(
      409,
    );
    await world.providerApi(provider, 'post', `/bookings/${id}/start`);
    const res = await as(admin.auth).post(`/admin/bookings/${id}/status`, {
      status: 'completed',
      note: 'تأكيد هاتفي',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.booking.status).toBe('completed');
    expect(await WalletLedgerModel.exists({ bookingId: id, type: 'commission_due' })).toBeTruthy();
    expect(await AuditLogModel.exists({ action: 'booking.force_status', entityId: id })).toBeTruthy();
    // Not a move the state machine allows from here.
    expect((await as(admin.auth).post(`/admin/bookings/${id}/status`, { status: 'cancelled' })).status).toBe(
      409,
    );
  });

  it('reassigns to a free provider who offers the service, and refuses a busy one', async () => {
    const id = await bookAt('10:00');
    const other = await world.newProvider();
    const busy = await world.newProvider();
    await accept(await bookAt('10:00', await world.newPatient(), busy), busy);

    const refused = await as(admin.auth).post(`/admin/bookings/${id}/reassign`, {
      provider_profile_id: busy.id,
    });
    expect(refused.body.error.code).toBe('SLOT_UNAVAILABLE');

    const res = await as(admin.auth).post(`/admin/bookings/${id}/reassign`, {
      provider_profile_id: other.id,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.booking).toMatchObject({ status: 'accepted', provider_profile_id: other.id });
    await eventually(() => expect(queuedPushes().some((p) => p.userId === other.userId)).toBe(true));

    // Already accepted: move it again, back to the first provider.
    const back = await as(admin.auth).post(`/admin/bookings/${id}/reassign`, {
      provider_profile_id: provider.id,
    });
    expect(back.body.data.booking).toMatchObject({ status: 'accepted', provider_profile_id: provider.id });
    expect(
      (await as(admin.auth).post(`/admin/bookings/${id}/reassign`, { provider_profile_id: provider.id }))
        .status,
    ).toBe(422);
  });
});

describe('reviews moderation', () => {
  it('masks contact details (keeping the original) and hiding a review updates the rating', async () => {
    const id = await bookAt('10:00');
    for (const step of ['accept', 'on-the-way', 'start', 'complete']) {
      await world.providerApi(provider, 'post', `/bookings/${id}/${step}`);
    }
    await as(patient.auth).post(`/bookings/${id}/review`, { rating: 2, comment: 'كلموني على 01001234567' });

    const flagged = await as(admin.auth).get('/admin/reviews?flagged=true');
    expect(flagged.body.data).toHaveLength(1);
    const reviewId = flagged.body.data[0].id;

    const masked = await as(admin.auth).patch(`/admin/reviews/${reviewId}`, { mask_contact: true });
    expect(masked.body.data).toMatchObject({
      comment: 'كلموني على ***',
      original_comment: 'كلموني على 01001234567',
      flagged: false,
    });
    expect((await ProviderProfileModel.findById(provider.id).lean())!.ratingCount).toBe(1);

    await as(admin.auth).patch(`/admin/reviews/${reviewId}`, { is_visible: false });
    expect(await ProviderProfileModel.findById(provider.id).lean()).toMatchObject({
      ratingAvg: 0,
      ratingCount: 0,
    });
    expect((await as(patient.auth).get(`/providers/${provider.id}/reviews`)).body.meta.total).toBe(0);
    expect((await as(admin.auth).patch(`/admin/reviews/${reviewId}`, {})).status).toBe(422);
  });
});

describe('dashboard, attention and the document check', () => {
  it('dashboard KPIs and the 14-day chart', async () => {
    await bookAt('10:00');
    const res = await as(admin.auth).get('/admin/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.data.kpis).toMatchObject({ active_providers: 1, open_disputes: 0 });
    expect(res.body.data.bookings_14d).toHaveLength(14);
    expect(res.body.data.bookings_14d.at(-1).count).toBe(1);
  });

  it('warns once about expiring documents and pauses providers whose license expired', async () => {
    const soon = new Date(Date.now() + 10 * 24 * 3600_000);
    const base = {
      fileKey: 'providers/x/doc.pdf',
      mime: 'application/pdf',
      status: DocumentReviewStatus.MATCHING,
    };
    await ProviderDocumentModel.create({
      ...base,
      providerProfileId: provider.id,
      type: ProviderDocumentType.SYNDICATE_CARD,
      expiresAt: soon,
    });
    const expired = await world.newProvider();
    await ProviderDocumentModel.create({
      ...base,
      providerProfileId: expired.id,
      type: ProviderDocumentType.LICENSE,
      expiresAt: new Date(Date.now() - 24 * 3600_000),
    });

    const job = Container.get(DocumentExpiryService);
    expect(await job.processDaily()).toEqual({ warned: 1, paused: 1 });
    expect(await job.processDaily()).toEqual({ warned: 0, paused: 0 }); // once only
    expect((await ProviderProfileModel.findById(expired.id).lean())!.isAcceptingBookings).toBe(false);
    expect((await ProviderProfileModel.findById(expired.id).lean())!.verificationStatus).toBe(
      VerificationStatus.APPROVED,
    );
    await eventually(() => {
      const users = queuedPushes().map((p) => p.userId);
      expect(users).toEqual(expect.arrayContaining([provider.userId, expired.userId]));
    });

    const attention = await as(admin.auth).get('/admin/attention');
    expect(attention.body.data.expiring_documents.map((d: { expired: boolean }) => d.expired).sort()).toEqual(
      [false, true],
    );
  });
});

describe('settings, audit log and admin accounts', () => {
  it('reads and updates settings (audited)', async () => {
    expect((await as(admin.auth).get('/admin/settings')).body.data.dispute_window_hours).toBe(48);
    const bad = await as(admin.auth).put('/admin/settings', { dispute_window_hours: 0, nope: 1 });
    expect(bad.status).toBe(422);
    expect(Object.keys(bad.body.error.fields).sort()).toEqual(['dispute_window_hours', 'nope']);
    const ok = await as(admin.auth).put('/admin/settings', { dispute_window_hours: 72 });
    expect(ok.body.data.dispute_window_hours).toBe(72);

    const log = await as(admin.auth).get(`/admin/audit-logs?actor_id=${admin.id}&entity_type=settings`);
    expect(log.body.data).toEqual([
      expect.objectContaining({ action: 'settings.update', actor_id: admin.id }),
    ]);
  });

  it('creates admins, disables / re-enables another admin, never yourself', async () => {
    const created = await as(admin.auth).post('/admin/admins', {
      phone: '+201099887766',
      full_name: 'سارة أحمد',
    });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ role: 'admin', status: 'active' });
    expect(
      (await as(admin.auth).post('/admin/admins', { phone: '+201099887766', full_name: 'تكرار' })).status,
    ).toBe(409);
    expect((await as(admin.auth).get('/admin/admins')).body.data).toHaveLength(2);

    expect((await as(admin.auth).patch(`/admin/admins/${admin.id}`, { status: 'suspended' })).status).toBe(
      409,
    );
    const disabled = await as(admin.auth).patch(`/admin/admins/${created.body.data.id}`, {
      status: 'suspended',
    });
    expect(disabled.body.data.status).toBe('suspended');
    expect(
      await AuditLogModel.exists({ action: 'admin.update', entityId: created.body.data.id }),
    ).toBeTruthy();
    const enabled = await as(admin.auth).patch(`/admin/admins/${created.body.data.id}`, { status: 'active' });
    expect(enabled.body.data.status).toBe('active');
    // Patients aren't admins.
    expect(
      (await as(admin.auth).patch(`/admin/admins/${patient.userId}`, { status: 'suspended' })).status,
    ).toBe(404);
  });
});
