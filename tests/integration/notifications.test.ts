import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { Container } from 'typedi';
import { io as connectSocket, type Socket } from 'socket.io-client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, signTestToken } from '../helpers/app';
import { useTestDatabase } from '../helpers/db';
import { createBookingWorld, tomorrowAt, type BookingWorld } from '../helpers/booking-world';
import { clearQueuedPushes, eventually, queuedPushes } from '../helpers/notifications';
import { NotificationModel } from '../../src/database/models/notification/notification.model';
import { BookingModel } from '../../src/database/models/booking/booking.model';
import { DeviceModel } from '../../src/database/models/auth/device.model';
import { UserModel } from '../../src/database/models/user/user.model';
import { DevicePlatform } from '../../src/interfaces/enums';
import { BookingReminderService } from '../../src/services/booking';
import {
  registerBookingNotifications,
  sendPushToUser,
  type PushClient,
} from '../../src/services/notification';
import { registerBookingSocketEvents } from '../../src/emit/booking.emit';
import { socketIOHandler } from '../../src/gateway';

useTestDatabase();
const app = createTestApp();

beforeAll(() => {
  registerBookingNotifications(); // done by runServer() in the real app
});

let world: BookingWorld;
beforeEach(async () => {
  clearQueuedPushes();
  world = await createBookingWorld(app);
});

const inbox = (userId: string) =>
  NotificationModel.find({ userId }).sort({ createdAt: 1 }).lean({ flattenMaps: true });
const templatesFor = async (userId: string) => (await inbox(userId)).map((n) => n.title);

describe('booking events → notifications', () => {
  it('direct request → provider; accept → patient; each with an in-app record and a push', async () => {
    const patient = await world.newPatient();
    const provider = await world.newProvider();
    const created = await world.book(patient, provider);
    const bookingId = created.body.data.id;

    const [request_] = await eventually(async () => {
      const list = await inbox(provider.userId);
      expect(list).toHaveLength(1);
      return list;
    });
    expect(request_).toMatchObject({
      type: 'booking_request',
      title: 'طلب حجز جديد',
      data: { booking_id: bookingId },
    });
    expect(request_.body).toContain('غيار على جرح');
    expect(request_.body).toContain('مدينة نصر');

    await world.providerApi(provider, 'post', `/bookings/${bookingId}/accept`).expect(200);
    const [accepted] = await eventually(async () => {
      const list = await inbox(patient.userId);
      expect(list).toHaveLength(1);
      return list;
    });
    expect(accepted).toMatchObject({
      type: 'booking_status',
      title: 'تم قبول حجزك',
      data: { booking_id: bookingId, status: 'accepted' },
    });
    expect(accepted.body).toContain('منى حسن');

    // Pushes carry the same text plus `type` + ids for deep linking (spec §7.13).
    expect(queuedPushes()).toEqual(
      expect.arrayContaining([
        {
          userId: patient.userId,
          title: 'تم قبول حجزك',
          body: accepted.body,
          data: {
            booking_id: bookingId,
            status: 'accepted',
            type: 'booking_status',
            notification_id: String(accepted._id),
          },
        },
      ]),
    );
  });

  it('a cancellation notifies the other party only', async () => {
    const patient = await world.newPatient();
    const provider = await world.newProvider();
    const created = await world.book(patient, provider);
    await world.providerApi(provider, 'post', `/bookings/${created.body.data.id}/accept`).expect(200);
    await request(app)
      .post(`/api/v1/bookings/${created.body.data.id}/cancel`)
      .set('Authorization', patient.auth)
      .send({ reason_code: 'changed_mind' })
      .expect(200);

    await eventually(async () =>
      expect(await templatesFor(provider.userId)).toEqual(['طلب حجز جديد', 'تم إلغاء الحجز']),
    );
    expect(await templatesFor(patient.userId)).toEqual(['تم قبول حجزك']);
  });

  it('fallback: the patient hears we’re looking; others get offers; the first provider loses the request', async () => {
    const patient = await world.newPatient();
    const first = await world.newProvider();
    const other = await world.newProvider();
    const created = await world.book(patient, first);
    await world.passDeadline(created.body.data.id);

    await eventually(async () => {
      expect(await templatesFor(patient.userId)).toEqual(['بنبحث لك عن مقدم خدمة آخر']);
      expect(await templatesFor(other.userId)).toEqual(['طلب متاح الآن']);
      expect(await templatesFor(first.userId)).toEqual(['طلب حجز جديد', 'الطلب لم يعد متاحاً']);
    });
  });

  it('a reschedule reaches the provider as a time change, not a new request', async () => {
    const patient = await world.newPatient();
    const provider = await world.newProvider();
    const created = await world.book(patient, provider);
    await request(app)
      .post(`/api/v1/bookings/${created.body.data.id}/reschedule`)
      .set('Authorization', patient.auth)
      .send({ scheduled_start: tomorrowAt('14:00') })
      .expect(200);
    await eventually(async () =>
      expect(await templatesFor(provider.userId)).toEqual(['طلب حجز جديد', 'طلب تغيير موعد']),
    );
  });
});

describe('visit reminders', () => {
  const acceptedBooking = async () => {
    const patient = await world.newPatient();
    const provider = await world.newProvider();
    const created = await world.book(patient, provider);
    await world.providerApi(provider, 'post', `/bookings/${created.body.data.id}/accept`).expect(200);
    await eventually(async () => expect(await inbox(patient.userId)).toHaveLength(1)); // the "accepted" notification
    await NotificationModel.deleteMany({});
    clearQueuedPushes();
    return { patient, provider, id: created.body.data.id as string };
  };
  const moveTo = (id: string, minutesFromNow: number) =>
    BookingModel.updateOne({ _id: id }, { scheduledStart: new Date(Date.now() + minutesFromNow * 60_000) });
  const reminders = Container.get(BookingReminderService);

  it('sends the day reminder within 24 h, the hour reminder within 1 h — once each, to both sides', async () => {
    const { patient, provider, id } = await acceptedBooking();
    await moveTo(id, 5 * 60);
    expect(await reminders.processDue()).toBe(1);
    expect(await reminders.processDue()).toBe(0); // no duplicates
    expect(await templatesFor(patient.userId)).toEqual(['تذكير بموعد زيارة']);
    expect(await templatesFor(provider.userId)).toEqual(['تذكير بموعد زيارة']);

    await moveTo(id, 30);
    expect(await reminders.processDue()).toBe(1);
    expect(await reminders.processDue()).toBe(0);
    expect(await templatesFor(patient.userId)).toEqual(['تذكير بموعد زيارة', 'الزيارة بعد ساعة']);
  });

  it('a visit less than an hour away gets only the hour reminder', async () => {
    const { patient, id } = await acceptedBooking();
    await moveTo(id, 30);
    await reminders.processDue();
    await reminders.processDue();
    expect(await templatesFor(patient.userId)).toEqual(['الزيارة بعد ساعة']);
  });

  it('turning reminders off silences the push but keeps the in-app notification', async () => {
    const { patient, provider, id } = await acceptedBooking();
    await request(app)
      .put('/api/v1/me/notification-settings')
      .set('Authorization', patient.auth)
      .send({ reminders: false })
      .expect(200);
    await moveTo(id, 5 * 60);
    await reminders.processDue();
    expect(await templatesFor(patient.userId)).toEqual(['تذكير بموعد زيارة']);
    expect(queuedPushes().map((p) => p.userId)).toEqual([provider.userId]);
  });
});

describe('inbox endpoints', () => {
  it('lists newest first, counts unread on /me, and marks read (own notifications only)', async () => {
    const patient = await world.newPatient();
    const provider = await world.newProvider();
    const created = await world.book(patient, provider);
    await world.providerApi(provider, 'post', `/bookings/${created.body.data.id}/accept`).expect(200);
    await world.providerApi(provider, 'post', `/bookings/${created.body.data.id}/on-the-way`).expect(200);
    await eventually(async () => expect(await inbox(patient.userId)).toHaveLength(2));

    const list = await request(app).get('/api/v1/notifications').set('Authorization', patient.auth);
    expect(list.body.data.map((n: { type: string; data: { status: string } }) => n.data.status)).toEqual([
      'on_the_way',
      'accepted',
    ]);
    expect(list.body.data[0]).toMatchObject({ read_at: null, title: 'منى حسن في الطريق إليك' });
    expect(
      (await request(app).get('/api/v1/me').set('Authorization', patient.auth)).body.data
        .unread_notifications,
    ).toBe(2);

    // Someone else's id is ignored.
    const providerNotification = (await inbox(provider.userId))[0];
    const one = await request(app)
      .post('/api/v1/notifications/read')
      .set('Authorization', patient.auth)
      .send({ ids: [list.body.data[0].id, String(providerNotification._id)] });
    expect(one.body.data).toEqual({ updated: 1, unread: 1 });
    expect((await NotificationModel.findById(providerNotification._id).lean())!.readAt).toBeNull();

    const all = await request(app)
      .post('/api/v1/notifications/read')
      .set('Authorization', patient.auth)
      .send({ all: true });
    expect(all.body.data).toEqual({ updated: 1, unread: 0 });
  });

  it('settings default to on and can be changed one at a time', async () => {
    const patient = await world.newPatient();
    const get = await request(app).get('/api/v1/me/notification-settings').set('Authorization', patient.auth);
    expect(get.body.data).toEqual({ reminders: true, promotions: true, chat: true });
    const put = await request(app)
      .put('/api/v1/me/notification-settings')
      .set('Authorization', patient.auth)
      .send({ promotions: false });
    expect(put.body.data).toEqual({ reminders: true, promotions: false, chat: true });
  });
});

describe('verification results', () => {
  it('the provider is told when an admin decides', async () => {
    const provider = await world.newProvider({ overrides: { verificationStatus: 'pending' as never } });
    const admin = await UserModel.create({ phone: '+201099999990', fullName: 'Admin', role: 'admin' });
    const auth = `Bearer ${signTestToken({ id: String(admin._id), role: 'admin' as never })}`;
    await request(app)
      .post(`/api/v1/admin/verifications/${provider.id}/request-changes`)
      .set('Authorization', auth)
      .send({ message: 'صورة الترخيص غير واضحة' })
      .expect(200);
    const [notification] = await inbox(provider.userId);
    expect(notification).toMatchObject({
      type: 'verification_result',
      title: 'مطلوب تعديلات على طلب التوثيق',
      body: 'صورة الترخيص غير واضحة',
      data: { status: 'changes_requested' },
    });
  });
});

describe('push delivery (FCM)', () => {
  /** Answers per token: `null` = delivered, otherwise the FCM error code for that token. */
  const fakeClient = (outcomes: Record<string, string | null>) =>
    ({
      sendEachForMulticast: async ({ tokens }: { tokens: string[] }) => {
        const responses = tokens.map((token) =>
          outcomes[token] === null ? { success: true } : { success: false, error: { code: outcomes[token] } },
        );
        return {
          successCount: responses.filter((r) => r.success).length,
          failureCount: responses.filter((r) => !r.success).length,
          responses,
        };
      },
    }) as unknown as PushClient;
  const message = (userId: string) => ({ userId, title: 't', body: 'b', data: { type: 'booking_status' } });

  it('sends to every device and forgets tokens FCM says are dead', async () => {
    const patient = await world.newPatient();
    await DeviceModel.create([
      { userId: patient.userId, fcmToken: 'ok', platform: DevicePlatform.ANDROID },
      { userId: patient.userId, fcmToken: 'dead', platform: DevicePlatform.IOS },
    ]);
    const result = await sendPushToUser(
      fakeClient({ ok: null, dead: 'messaging/registration-token-not-registered' }),
      message(patient.userId),
    );
    expect(result).toEqual({ sent: 1, removed: 1 });
    expect((await DeviceModel.find().lean()).map((d) => d.fcmToken)).toEqual(['ok']);
  });

  it('throws (so the queue retries) only when nothing got through', async () => {
    const patient = await world.newPatient();
    await DeviceModel.create({ userId: patient.userId, fcmToken: 'a', platform: DevicePlatform.ANDROID });
    await expect(
      sendPushToUser(fakeClient({ a: 'messaging/internal-error' }), message(patient.userId)),
    ).rejects.toThrow('FCM failed');
  });
});

describe('exit criterion: a status change reaches the other party live', () => {
  let server: http.Server;
  let url: string;
  const sockets: Socket[] = [];

  beforeAll(async () => {
    server = http.createServer(app);
    socketIOHandler(server);
    registerBookingSocketEvents(); // done by runServer() in the real app
    await new Promise<void>((resolve) => server.listen(0, resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => {
    while (sockets.length) sockets.pop()!.disconnect();
  });

  const connect = (token: string) =>
    new Promise<Socket>((resolve, reject) => {
      const socket = connectSocket(url, { auth: { token }, transports: ['websocket'], reconnection: false });
      sockets.push(socket);
      socket.on('connect', () => resolve(socket));
      socket.on('connect_error', reject);
    });
  const next = <T>(socket: Socket, event: string) =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no "${event}" within 3 s`)), 3000);
      socket.once(event, (payload: T) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });

  it('the patient’s app gets booking.status_changed and notification.new within seconds of the provider accepting', async () => {
    const patient = await world.newPatient();
    const provider = await world.newProvider();
    const created = await world.book(patient, provider);
    const bookingId = created.body.data.id;
    const socket = await connect(patient.auth.slice(7));

    const ack = await socket.emitWithAck('booking:subscribe', { booking_id: bookingId });
    expect(ack).toEqual({ ok: true });

    const statusChanged = next<{ booking_id: string; from: string; to: string }>(
      socket,
      'booking.status_changed',
    );
    const notification = next<{ title: string; data: { booking_id: string } }>(socket, 'notification.new');
    const started = Date.now();
    await world.providerApi(provider, 'post', `/bookings/${bookingId}/accept`).expect(200);

    expect(await statusChanged).toMatchObject({ booking_id: bookingId, from: 'pending', to: 'accepted' });
    expect(await notification).toMatchObject({ title: 'تم قبول حجزك', data: { booking_id: bookingId } });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('only participants can follow a booking’s room', async () => {
    const created = await world.book(await world.newPatient(), await world.newProvider());
    const stranger = await world.newPatient();
    const socket = await connect(stranger.auth.slice(7));
    expect(await socket.emitWithAck('booking:subscribe', { booking_id: created.body.data.id })).toEqual({
      ok: false,
    });
  });

  it('refuses connections with an expired token, telling the app to refresh', async () => {
    const patient = await world.newPatient();
    const expired = signTestToken({ id: patient.userId }, -10);
    await expect(connect(expired)).rejects.toMatchObject({ message: 'TOKEN_EXPIRED' });
  });
});
