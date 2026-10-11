import request from 'supertest';
import { Types } from 'mongoose';
import { Container } from 'typedi';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, signTestToken } from '../helpers/app';
import { useTestDatabase } from '../helpers/db';
import { createUser, createUserWithToken } from '../helpers/fixtures';
import {
  createBookingWorld,
  tomorrowAt,
  type BookingWorld,
  type TestPatient,
} from '../helpers/booking-world';
import { clearQueuedPushes, queuedPushes } from '../helpers/notifications';
import { BookingModel } from '../../src/database/models/booking/booking.model';
import { UserModel } from '../../src/database/models/user/user.model';
import { NotificationModel } from '../../src/database/models/notification/notification.model';
import { BroadcastModel } from '../../src/database/models/marketing/marketing.models';
import { AuditLogModel } from '../../src/database/models/audit-log/audit-log.model';
import { AdminRole, UserRole, UserStatus } from '../../src/interfaces/enums';
import { BookingStatus } from '../../src/interfaces/IBooking';
import { BroadcastService } from '../../src/services/marketing';
import { addDays, cairoDate, cairoToUtc, dayOfWeek } from '../../src/utils/time/cairo';

useTestDatabase();
const app = createTestApp();

let world: BookingWorld;
let admin: Awaited<ReturnType<typeof createUserWithToken>>;

const adminAs = async (adminRole: AdminRole) => {
  const user = await createUser({ role: UserRole.ADMIN, adminRole });
  const id = String(user._id);
  return { id, auth: `Bearer ${signTestToken({ id, role: UserRole.ADMIN })}` };
};
const as = (auth: string) => ({
  get: (path: string) => request(app).get(`/api/v1${path}`).set('Authorization', auth),
  post: (path: string, body: object) =>
    request(app).post(`/api/v1${path}`).set('Authorization', auth).send(body),
});

beforeEach(async () => {
  world = await createBookingWorld(app);
  admin = await createUserWithToken(UserRole.ADMIN);
  clearQueuedPushes();
});

describe('GET /admin/analytics', () => {
  it('bookings, completions, money, rates and sign-ups by Cairo day, zero-filled', async () => {
    const provider = await world.newProvider();
    const patients = [await world.newPatient(), await world.newPatient(), await world.newPatient()];
    const ids: string[] = [];
    for (const [i, p] of patients.entries()) {
      const res = await world.book(p, provider, { scheduled_start: tomorrowAt(`1${i}:00`) });
      expect(res.status).toBe(201);
      ids.push(res.body.data.id);
    }
    const today = cairoDate();
    const yesterdayNoon = cairoToUtc(addDays(today, -1), '12:00');
    await BookingModel.updateOne(
      { _id: ids[0] },
      { status: BookingStatus.COMPLETED, completedAt: yesterdayNoon },
    );
    await BookingModel.updateOne({ _id: ids[1] }, { status: BookingStatus.CANCELLED });
    const done = (await BookingModel.findById(ids[0]).lean())!;

    const from = addDays(today, -2);
    const get = async (metric: string, extra = '') => {
      const res = await as(admin.auth).get(
        `/admin/analytics?metric=${metric}&from=${from}&to=${today}${extra}`,
      );
      expect(res.status, metric).toBe(200);
      return res.body.data as { total: number; series: Array<{ period: string; value: number | null }> };
    };
    const byDay = (values: Array<number | null>) =>
      values.map((value, i) => ({ period: addDays(from, i), value }));

    expect(await get('bookings')).toMatchObject({
      metric: 'bookings',
      group_by: 'day',
      total: 3,
      series: byDay([0, 0, 3]),
    });
    expect(await get('completed_visits')).toMatchObject({ total: 1, series: byDay([0, 1, 0]) });
    expect((await get('gmv')).series).toEqual(byDay([0, done.price.total, 0]));
    expect((await get('revenue')).total).toBe(done.price.commissionAmount);
    const cancellation = await get('cancellation_rate');
    expect(cancellation.total).toBe(0.333);
    expect(cancellation.series).toEqual(byDay([null, null, 0.333]));
    expect((await get('active_providers')).total).toBe(1);
    expect((await get('new_patients')).total).toBe(3);
    expect((await get('new_providers')).total).toBe(1);

    const week = await get('bookings', '&group_by=week');
    expect(dayOfWeek(week.series[0].period)).toBe(6); // weeks start on Saturday
    expect(week.total).toBe(3);
    const month = await get('bookings', '&group_by=month');
    expect(month.series[0].period).toBe(`${from.slice(0, 8)}01`);
  });

  it('checks the range; every admin role may read it', async () => {
    const today = cairoDate();
    const q = (from: string, to: string, extra = '') =>
      `/admin/analytics?metric=bookings&from=${from}&to=${to}${extra}`;
    expect((await as(admin.auth).get(q(today, addDays(today, -1)))).status).toBe(400);
    expect((await as(admin.auth).get(q(addDays(today, -100), today))).status).toBe(400);
    expect((await as(admin.auth).get(q(addDays(today, -100), today, '&group_by=week'))).status).toBe(200);
    expect((await as(admin.auth).get(`/admin/analytics?metric=nope&from=${today}&to=${today}`)).status).toBe(
      422,
    );
    const marketing = await adminAs(AdminRole.MARKETING);
    expect((await as(marketing.auth).get(q(today, today))).status).toBe(200);
  });
});

describe('POST /admin/notifications/broadcast', () => {
  let optedIn: TestPatient;
  let optedOut: TestPatient;
  let suspended: TestPatient;

  beforeEach(async () => {
    optedIn = await world.newPatient();
    optedOut = await world.newPatient();
    suspended = await world.newPatient();
    await UserModel.updateOne({ _id: optedOut.userId }, { 'notificationSettings.promotions': false });
    await UserModel.updateOne({ _id: suspended.userId }, { status: UserStatus.SUSPENDED });
    await world.newProvider();
  });

  const offer = { role: 'patient', title: 'خصم ٢٠٪', body: 'على أول زيارة تمريض هذا الأسبوع' };
  const notified = async (userId: string) => NotificationModel.find({ userId }).lean();
  const pushedTo = (userId: string) => queuedPushes().filter((p) => p.userId === userId);

  it('marketing: preview, then in-app for everyone, push only with promotions on; skips suspended; audited', async () => {
    const preview = await as(admin.auth).post('/admin/notifications/broadcast', { ...offer, dry_run: true });
    expect(preview.status).toBe(200);
    expect(preview.body.data).toEqual({ dry_run: true, audience: 2, push_audience: 1 });
    expect(await BroadcastModel.countDocuments()).toBe(0);

    const sent = await as(admin.auth).post('/admin/notifications/broadcast', offer);
    expect(sent.status).toBe(202);
    expect(sent.body.data).toMatchObject({ type: 'marketing', status: 'queued', audience: 2, sent_count: 0 });
    expect(await Container.get(BroadcastService).processDue()).toBe(1);

    expect(await notified(optedIn.userId)).toEqual([
      expect.objectContaining({ type: 'promo', title: offer.title, body: offer.body }),
    ]);
    expect(await notified(optedOut.userId)).toHaveLength(1);
    expect(await notified(suspended.userId)).toHaveLength(0);
    expect(pushedTo(optedIn.userId)).toHaveLength(1);
    expect(pushedTo(optedOut.userId)).toHaveLength(0);
    expect(await NotificationModel.countDocuments({ userId: admin.id })).toBe(0);

    const [row] = (await as(admin.auth).get('/admin/notifications/broadcasts')).body.data;
    expect(row).toMatchObject({ status: 'sent', sent_count: 2, segment: { role: 'patient', area_ids: [] } });
    expect(await AuditLogModel.exists({ action: 'broadcast.create', actorId: admin.id })).toBeTruthy();
    expect(await Container.get(BroadcastService).processDue()).toBe(0);
  });

  it('marketing: at most 3 a day; marketing admins may send them but not announcements', async () => {
    const marketing = await adminAs(AdminRole.MARKETING);
    for (let i = 0; i < 3; i++) {
      expect((await as(marketing.auth).post('/admin/notifications/broadcast', offer)).status).toBe(202);
    }
    const fourth = await as(marketing.auth).post('/admin/notifications/broadcast', offer);
    expect(fourth.status).toBe(409);
    const announcement = await as(marketing.auth).post('/admin/notifications/broadcast', {
      ...offer,
      type: 'announcement',
      reason: 'صيانة مجدولة للنظام',
    });
    expect(announcement.status).toBe(403);
    const support = await adminAs(AdminRole.SUPPORT);
    expect((await as(support.auth).post('/admin/notifications/broadcast', offer)).status).toBe(403);
  });

  it('announcement: super admin only, reason required, pushed to everyone regardless of promotions, 1 a day', async () => {
    const notice = {
      type: 'announcement',
      title: 'صيانة مجدولة',
      body: 'التطبيق سيتوقف من ٢ إلى ٤ صباحًا يوم الجمعة',
    };
    expect((await as(admin.auth).post('/admin/notifications/broadcast', notice)).status).toBe(422);
    const sent = await as(admin.auth).post('/admin/notifications/broadcast', {
      ...notice,
      reason: 'تحديث قاعدة البيانات',
    });
    expect(sent.status).toBe(202);
    expect(sent.body.data).toMatchObject({
      type: 'announcement',
      reason: 'تحديث قاعدة البيانات',
      audience: 3,
    });
    await Container.get(BroadcastService).processDue();
    expect(pushedTo(optedIn.userId)).toHaveLength(1);
    expect(pushedTo(optedOut.userId)).toHaveLength(1);
    expect(pushedTo(suspended.userId)).toHaveLength(0);
    expect((await notified(optedOut.userId))[0].type).toBe('announcement');

    expect(
      (await as(admin.auth).post('/admin/notifications/broadcast', { ...notice, reason: 'تحديث آخر للنظام' }))
        .status,
    ).toBe(409);
  });

  it('segments by area; an empty audience is refused', async () => {
    const maadiPatient = await world.newPatient(world.maadi);
    const inMaadi = await as(admin.auth).post('/admin/notifications/broadcast', {
      ...offer,
      area_ids: [world.maadi],
      dry_run: true,
    });
    expect(inMaadi.body.data.audience).toBe(1);
    const providers = await as(admin.auth).post('/admin/notifications/broadcast', {
      ...offer,
      role: 'provider',
      area_ids: [world.nasrCity],
      dry_run: true,
    });
    expect(providers.body.data.audience).toBe(1);

    const nobody = await as(admin.auth).post('/admin/notifications/broadcast', {
      ...offer,
      area_ids: [String(new Types.ObjectId())],
    });
    expect(nobody.status).toBe(409);

    await as(admin.auth)
      .post('/admin/notifications/broadcast', { ...offer, area_ids: [world.maadi] })
      .expect(202);
    await Container.get(BroadcastService).processDue();
    expect(await notified(maadiPatient.userId)).toHaveLength(1);
    expect(await notified(optedIn.userId)).toHaveLength(0);
  });

  it('a run out of time leaves the rest for the next run', async () => {
    await as(admin.auth).post('/admin/notifications/broadcast', offer).expect(202);
    expect(await Container.get(BroadcastService).processDue(undefined, 0)).toBe(0);
    expect((await BroadcastModel.findOne().lean())!.status).toBe('queued');
    expect(await Container.get(BroadcastService).processDue()).toBe(1);
  });

  it('a run resumed after a crash never delivers the same broadcast twice to anyone', async () => {
    await as(admin.auth).post('/admin/notifications/broadcast', offer).expect(202);
    await Container.get(BroadcastService).processDue();
    expect(await notified(optedIn.userId)).toHaveLength(1);
    expect(pushedTo(optedIn.userId)).toHaveLength(1);

    // As if the process died after notifying but before saving progress: the batch runs again.
    await BroadcastModel.updateOne({}, { status: 'sending', cursor: null, lockedUntil: null, sentCount: 0 });
    expect(await Container.get(BroadcastService).processDue()).toBe(1);
    expect(await notified(optedIn.userId)).toHaveLength(1);
    expect(await notified(optedOut.userId)).toHaveLength(1);
    expect(pushedTo(optedIn.userId)).toHaveLength(1);
  });
});
