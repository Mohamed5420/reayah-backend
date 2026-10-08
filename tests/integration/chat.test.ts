import http from 'node:http';
import type { AddressInfo } from 'node:net';
import mongoose from 'mongoose';
import request from 'supertest';
import { io as connectSocket, type Socket } from 'socket.io-client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app';
import { useTestDatabase } from '../helpers/db';
import { sampleFiles, useFakeStorage } from '../helpers/storage';
import { clearQueuedPushes, eventually, queuedPushes } from '../helpers/notifications';
import {
  createBookingWorld,
  tomorrowAt,
  type BookingWorld,
  type TestPatient,
  type TestProvider,
} from '../helpers/booking-world';
import { BookingModel } from '../../src/database/models/booking/booking.model';
import { ConversationModel, MessageModel } from '../../src/database/models/chat/chat.models';
import { ChatRole } from '../../src/interfaces/IChat';
import { socketIOHandler } from '../../src/gateway';
import { createUserWithToken } from '../helpers/fixtures';
import { UserRole } from '../../src/interfaces/enums';
import { AuditLogModel } from '../../src/database/models/audit-log/audit-log.model';

/** M2.2: patient ↔ provider chat per booking (spec §7.12). */

useTestDatabase();
useFakeStorage();
const app = createTestApp();

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

const as = (auth: string) => ({
  get: (path: string) => request(app).get(`/api/v1${path}`).set('Authorization', auth),
  post: (path: string, body?: object) =>
    request(app).post(`/api/v1${path}`).set('Authorization', auth).send(body),
  patch: (path: string, body: object) =>
    request(app).patch(`/api/v1${path}`).set('Authorization', auth).send(body),
});

const booking = async (until?: 'accept' | 'complete') => {
  const res = await world.book(patient, provider, {
    scheduled_start: tomorrowAt(`${String(nextHour++).padStart(2, '0')}:00`),
  });
  const id: string = res.body.data.id;
  const steps =
    until === 'complete' ? ['accept', 'on-the-way', 'start', 'complete'] : until ? ['accept'] : [];
  for (const step of steps) await world.providerApi(provider, 'post', `/bookings/${id}/${step}`);
  return id;
};

describe('when chat is open', () => {
  it('opens on accept and closes 24 hours after completion; history stays readable', async () => {
    const id = await booking();
    const early = await as(patient.auth).post(`/bookings/${id}/messages`, { body: 'السلام عليكم' });
    expect(early.status).toBe(409);
    expect(early.body.error.message).toBe('المحادثة متاحة من قبول الحجز حتى 24 ساعة بعد انتهاء الزيارة');
    expect((await as(patient.auth).get(`/bookings/${id}`)).body.data.can_chat).toBe(false);

    await world.providerApi(provider, 'post', `/bookings/${id}/accept`);
    expect((await as(patient.auth).get(`/bookings/${id}`)).body.data.can_chat).toBe(true);
    expect((await world.providerApi(provider, 'get', `/bookings/${id}`)).body.data.can_chat).toBe(true);
    expect((await as(patient.auth).post(`/bookings/${id}/messages`, { body: 'السلام عليكم' })).status).toBe(
      201,
    );

    for (const step of ['on-the-way', 'start', 'complete'])
      await world.providerApi(provider, 'post', `/bookings/${id}/${step}`);
    expect((await as(provider.auth).post(`/bookings/${id}/messages`, { body: 'سلامتك' })).status).toBe(201);

    await BookingModel.updateOne({ _id: id }, { completedAt: new Date(Date.now() - 25 * 3600_000) });
    expect((await as(patient.auth).post(`/bookings/${id}/messages`, { body: 'شكراً' })).status).toBe(409);
    const history = await as(patient.auth).get(`/bookings/${id}/messages`);
    expect(history.body.data).toHaveLength(2);
    expect(history.body.meta.can_send).toBe(false);
  });

  it('only the booking’s patient and assigned provider take part', async () => {
    const id = await booking('accept');
    const stranger = await world.newPatient();
    const otherNurse = await world.newProvider();
    expect((await as(stranger.auth).post(`/bookings/${id}/messages`, { body: 'hi' })).status).toBe(404);
    expect((await as(otherNurse.auth).get(`/bookings/${id}/messages`)).status).toBe(404);
    expect((await as(patient.auth).post(`/bookings/${id}/messages`, {})).status).toBe(422);
  });
});

describe('messages', () => {
  it('are encrypted at rest, listed newest first, and marked read by the other side', async () => {
    const id = await booking('accept');
    await as(patient.auth).post(`/bookings/${id}/messages`, {
      body: 'والدي عنده سكر ومحتاج قياس قبل الحقنة',
    });
    const reply = await as(provider.auth).post(`/bookings/${id}/messages`, {
      body: 'تمام، هجيب الجهاز معايا',
    });
    expect(reply.body.data).toMatchObject({
      sender_role: 'provider',
      body: 'تمام، هجيب الجهاز معايا',
      read_at: null,
    });

    const raw = await mongoose.connection
      .collection('messages')
      .find({ bookingId: new mongoose.Types.ObjectId(id) })
      .toArray();
    expect(raw.every((m) => String(m.body).startsWith('enc:v1:'))).toBe(true);
    const rawConversation = await ConversationModel.collection.findOne({
      bookingId: new mongoose.Types.ObjectId(id),
    });
    expect(String(rawConversation!.lastMessage.body)).toMatch(/^enc:v1:/);

    const list = await as(patient.auth).get(`/bookings/${id}/messages`);
    expect(list.body.data.map((m: { body: string }) => m.body)).toEqual([
      'تمام، هجيب الجهاز معايا',
      'والدي عنده سكر ومحتاج قياس قبل الحقنة',
    ]);

    // Provider's inbox: one unread from the patient.
    const inbox = await as(provider.auth).get('/conversations');
    expect(inbox.body.data[0]).toMatchObject({
      booking: { id },
      with: { id: patient.userId },
      last_message: { body: 'تمام، هجيب الجهاز معايا', sender_role: 'provider' },
      unread_count: 1,
      can_send: true,
    });
    expect((await as(patient.auth).get('/conversations')).body.data[0]).toMatchObject({
      with: { id: provider.userId },
      unread_count: 1,
    });

    expect((await as(provider.auth).post(`/bookings/${id}/messages/read`)).body.data).toEqual({ read: 1 });
    expect((await as(provider.auth).get('/conversations')).body.data[0].unread_count).toBe(0);
    const mine = await MessageModel.findOne({ bookingId: id, senderRole: ChatRole.PATIENT }).lean();
    expect(mine!.readAt).toBeInstanceOf(Date);
  });

  it('pages with a cursor', async () => {
    const id = await booking('accept');
    await as(patient.auth).post(`/bookings/${id}/messages`, { body: 'رسالة 0' });
    const conversation = await ConversationModel.findOne({ bookingId: id }).lean();
    for (let i = 1; i <= 34; i++) {
      await MessageModel.create({
        conversationId: conversation!._id,
        bookingId: id,
        senderId: patient.userId,
        senderRole: ChatRole.PATIENT,
        body: `رسالة ${i}`,
      });
    }
    const first = await as(patient.auth).get(`/bookings/${id}/messages?limit=30`);
    expect(first.body.data).toHaveLength(30);
    expect(first.body.data[0].body).toBe('رسالة 34');
    const second = await as(patient.auth).get(
      `/bookings/${id}/messages?limit=30&before=${first.body.meta.next_before}`,
    );
    expect(second.body.data.map((m: { body: string }) => m.body)).toEqual([
      'رسالة 4',
      'رسالة 3',
      'رسالة 2',
      'رسالة 1',
      'رسالة 0',
    ]);
    expect(second.body.meta.next_before).toBeNull();
  });

  it('carry attachments uploaded with purpose chat', async () => {
    const id = await booking('accept');
    const upload = await request(app)
      .post('/api/v1/uploads')
      .set('Authorization', patient.auth)
      .field('purpose', 'chat')
      .attach('file', sampleFiles.jpeg, 'جرح.jpg');
    expect(upload.status).toBe(201);
    const sent = await as(patient.auth).post(`/bookings/${id}/messages`, {
      attachment_key: upload.body.data.file_key,
    });
    expect(sent.status).toBe(201);
    expect(sent.body.data.attachment).toMatchObject({
      mime: 'image/jpeg',
      file_url: expect.stringContaining('chat'),
    });
  });
});

describe('push for new messages', () => {
  it('tells the other party without the message text, and respects the chat setting', async () => {
    const id = await booking('accept');
    await as(patient.auth).post(`/bookings/${id}/messages`, { body: 'سر طبي لا يخرج للإشعارات' });
    const push = await eventually(() => {
      const found = queuedPushes().find(
        (p) => p.userId === provider.userId && p.data.type === 'chat_message',
      );
      expect(found).toBeDefined();
      return found!;
    });
    expect(push.title).toBe('رسالة جديدة');
    expect(push.body).not.toContain('سر طبي');
    expect(push.data.booking_id).toBe(id);

    clearQueuedPushes();
    const off = await request(app)
      .put('/api/v1/me/notification-settings')
      .set('Authorization', provider.auth)
      .send({ chat: false });
    expect(off.status).toBe(200);
    await as(patient.auth).post(`/bookings/${id}/messages`, { body: 'تاني' });
    expect(queuedPushes().filter((p) => p.userId === provider.userId)).toEqual([]);
  });
});

describe('live', () => {
  let url: string;
  const sockets: Socket[] = [];

  beforeAll(async () => {
    const server = http.createServer(app);
    socketIOHandler(server);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => {
    while (sockets.length) sockets.pop()!.disconnect();
  });

  const connect = (auth: string) =>
    new Promise<Socket>((resolve, reject) => {
      const socket = connectSocket(url, {
        auth: { token: auth.slice(7) },
        transports: ['websocket'],
        reconnection: false,
      });
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

  it('message.new and message.read reach the open chat; no push while it is open', async () => {
    const id = await booking('accept');
    const nurseSocket = await connect(provider.auth);
    expect(await nurseSocket.emitWithAck('booking:subscribe', { booking_id: id })).toEqual({ ok: true });

    const incoming = next<{ booking_id: string; message: { body: string } }>(nurseSocket, 'message.new');
    await as(patient.auth).post(`/bookings/${id}/messages`, { body: 'أنا مستنية' });
    expect(await incoming).toMatchObject({
      event: 'message.new',
      booking_id: id,
      message: { body: 'أنا مستنية' },
    });
    expect(queuedPushes().filter((p) => p.data.type === 'chat_message')).toEqual([]);

    const patientSocket = await connect(patient.auth);
    const read = next<{ reader_role: string }>(patientSocket, 'message.read');
    await as(provider.auth).post(`/bookings/${id}/messages/read`);
    expect(await read).toMatchObject({ event: 'message.read', booking_id: id, reader_role: 'provider' });
  });
});

describe('after an admin reassigns the booking', () => {
  it('the new provider starts fresh, the old chat is read-only for the patient, hidden from both providers, kept for admins', async () => {
    const admin = await createUserWithToken(UserRole.ADMIN);
    const id = await booking('accept');
    await as(patient.auth).post(`/bookings/${id}/messages`, { body: 'للممرضة الأولى' });
    await as(provider.auth).post(`/bookings/${id}/messages`, { body: 'رد الممرضة الأولى' });

    const newcomer = await world.newProvider();
    const moved = await as(admin.auth).post(`/admin/bookings/${id}/reassign`, {
      provider_profile_id: newcomer.id,
    });
    expect(moved.status).toBe(200);

    // Previous provider: no access at all.
    expect((await as(provider.auth).get(`/bookings/${id}/messages`)).status).toBe(404);
    expect((await as(provider.auth).get('/conversations')).body.data).toEqual([]);

    // New provider: an empty chat, then their own conversation.
    const fresh = await as(newcomer.auth).get(`/bookings/${id}/messages`);
    expect(fresh.body.data).toEqual([]);
    expect(fresh.body.meta).toMatchObject({ can_send: true, conversation_id: null });
    await as(newcomer.auth).post(`/bookings/${id}/messages`, { body: 'أنا الممرضة الجديدة' });
    const theirs = await as(newcomer.auth).get(`/bookings/${id}/messages`);
    expect(theirs.body.data.map((m: { body: string }) => m.body)).toEqual(['أنا الممرضة الجديدة']);

    // Patient: both conversations; the old one closed and read-only.
    const list = await as(patient.auth).get('/conversations');
    expect(list.body.data).toHaveLength(2);
    const old = list.body.data.find((c: { closed: boolean }) => c.closed);
    expect(old).toMatchObject({ closed: true, can_send: false, with: { id: provider.userId } });
    const oldMessages = await as(patient.auth).get(`/bookings/${id}/messages?conversation_id=${old.id}`);
    expect(oldMessages.body.data.map((m: { body: string }) => m.body)).toEqual([
      'رد الممرضة الأولى',
      'للممرضة الأولى',
    ]);
    expect(oldMessages.body.meta.can_send).toBe(false);
    expect((await as(newcomer.auth).get(`/bookings/${id}/messages?conversation_id=${old.id}`)).status).toBe(
      404,
    );
    const current = await as(patient.auth).get(`/bookings/${id}/messages`);
    expect(current.body.data.map((m: { body: string }) => m.body)).toEqual(['أنا الممرضة الجديدة']);

    // Admins see everything, and the view is audited.
    const review = await as(admin.auth).get(`/admin/bookings/${id}/conversations`);
    expect(review.body.data).toHaveLength(2);
    expect(review.body.data[0]).toMatchObject({
      closed_reason: 'reassigned',
      provider_profile_id: provider.id,
    });
    expect(review.body.data[0].messages.map((m: { body: string }) => m.body)).toEqual([
      'للممرضة الأولى',
      'رد الممرضة الأولى',
    ]);
    expect(await AuditLogModel.exists({ action: 'chat.read', entityId: id, actorId: admin.id })).toBeTruthy();
  });
});
