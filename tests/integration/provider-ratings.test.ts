import request from 'supertest';
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
import { UserRole } from '../../src/interfaces/enums';

/** Provider app (M21): rating summary, sorted list, and support finding one rating by id. */

useTestDatabase();
const app = createTestApp();

let world: BookingWorld;
let patient: TestPatient;
let provider: TestProvider;

const get = (auth: string, path: string) => request(app).get(`/api/v1${path}`).set('Authorization', auth);

/** A visit at `time` tomorrow, carried through to completed, then rated by the patient. */
const rate = async (time: string, rating: number, tags: string[]) => {
  const id = (await world.book(patient, provider, { scheduled_start: tomorrowAt(time) })).body.data.id;
  for (const step of ['accept', 'on-the-way', 'start', 'complete']) {
    await world.providerApi(provider, 'post', `/bookings/${id}/${step}`);
  }
  const res = await request(app)
    .post(`/api/v1/bookings/${id}/review`)
    .set('Authorization', patient.auth)
    .send({ rating, tags });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.id as string;
};

beforeEach(async () => {
  world = await createBookingWorld(app);
  patient = await world.newPatient();
  provider = await world.newProvider();
});

describe('provider ratings', () => {
  it('summary per star with zeros and the most chosen tags; list sorted newest, highest or lowest; support finds one by id', async () => {
    await rate('09:00', 5, ['punctual', 'gentle']);
    await rate('11:00', 4, ['punctual']);
    const third = await rate('13:00', 2, ['punctual', 'clean']);

    const summary = (await get(provider.auth, '/provider/reviews/summary')).body.data;
    expect(summary).toEqual({
      rating_avg: 3.7,
      rating_count: 3,
      distribution: { 1: 0, 2: 1, 3: 0, 4: 1, 5: 1 },
      top_tags: [
        { tag: 'punctual', count: 3 },
        { tag: 'clean', count: 1 },
        { tag: 'gentle', count: 1 },
      ],
    });

    const ratings = async (query = '') =>
      (await get(provider.auth, `/provider/reviews${query}`)).body.data.map(
        (r: { rating: number }) => r.rating,
      );
    expect(await ratings()).toEqual([2, 4, 5]);
    expect(await ratings('?sort=highest')).toEqual([5, 4, 2]);
    expect(await ratings('?sort=lowest')).toEqual([2, 4, 5]);
    expect((await get(provider.auth, '/provider/reviews?sort=best')).status).toBe(422);

    const support = await createUserWithToken(UserRole.ADMIN);
    const found = (await get(support.auth, `/admin/reviews?review_id=${third}`)).body.data;
    expect(found.map((r: { id: string }) => r.id)).toEqual([third]);
  });
});
