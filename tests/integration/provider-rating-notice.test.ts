import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app';
import { useTestDatabase } from '../helpers/db';
import { clearQueuedPushes, queuedPushes } from '../helpers/notifications';
import {
  createBookingWorld,
  tomorrowAt,
  type BookingWorld,
  type TestPatient,
  type TestProvider,
} from '../helpers/booking-world';
import { NotificationModel } from '../../src/database/models/notification/notification.model';

/** A new rating tells the provider (type review_received), unless muted or held for moderation. */

useTestDatabase();
const app = createTestApp();

let world: BookingWorld;
let patient: TestPatient;
let provider: TestProvider;

const rate = async (time: string, body: object) => {
  const id = (await world.book(patient, provider, { scheduled_start: tomorrowAt(time) })).body.data.id;
  for (const step of ['accept', 'on-the-way', 'start', 'complete']) {
    await world.providerApi(provider, 'post', `/bookings/${id}/${step}`);
  }
  clearQueuedPushes();
  const res = await request(app)
    .post(`/api/v1/bookings/${id}/review`)
    .set('Authorization', patient.auth)
    .send(body);
  expect(res.status).toBe(201);
  return { bookingId: id as string, reviewId: res.body.data.id as string };
};
const notices = () => NotificationModel.find({ userId: provider.userId, type: 'review_received' }).lean();
const pushes = () =>
  queuedPushes().filter((p) => p.userId === provider.userId && p.data.type === 'review_received');

beforeEach(async () => {
  world = await createBookingWorld(app);
  patient = await world.newPatient();
  provider = await world.newProvider();
});

describe('rating notice', () => {
  it('in-app and push with type + event and ids, never the comment; the reviews setting mutes only the push', async () => {
    const first = await rate('09:00', { rating: 4, comment: 'ممتازة جدًا', tags: ['gentle'] });
    const [notice] = await notices();
    expect(notice.data).toMatchObject({
      event: 'review_received',
      review_id: first.reviewId,
      booking_id: first.bookingId,
      rating: '4',
    });
    expect(notice.body).not.toContain('ممتازة');
    expect(pushes()[0].data).toMatchObject({ type: 'review_received', event: 'review_received' });

    await request(app)
      .put('/api/v1/me/notification-settings')
      .set('Authorization', provider.auth)
      .send({ reviews: false })
      .expect(200);
    await rate('11:00', { rating: 5 });
    expect(await notices()).toHaveLength(2);
    expect(pushes()).toHaveLength(0);
  });

  it('a rating held for moderation (contact details) sends nothing', async () => {
    await rate('13:00', { rating: 1, comment: 'كلمني على 01001234567' });
    expect(await notices()).toHaveLength(0);
  });
});
