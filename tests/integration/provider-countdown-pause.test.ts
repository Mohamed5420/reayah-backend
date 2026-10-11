import request from 'supertest';
import { Container } from 'typedi';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app';
import { useTestDatabase } from '../helpers/db';
import {
  createBookingWorld,
  type BookingWorld,
  type TestPatient,
  type TestProvider,
} from '../helpers/booking-world';
import { BookingModel } from '../../src/database/models/booking/booking.model';
import { ProviderProfileModel } from '../../src/database/models/provider/provider-profile.model';
import { NotificationModel } from '../../src/database/models/notification/notification.model';
import { ProviderProfileService } from '../../src/services/provider';
import { addDays, cairoDate, cairoToUtc } from '../../src/utils/time/cairo';

/** Provider app (M21): the reply countdown on new requests and pausing until a set time. */

useTestDatabase();
const app = createTestApp();

let world: BookingWorld;
let patient: TestPatient;
let provider: TestProvider;

const get = (path: string) => request(app).get(`/api/v1${path}`).set('Authorization', provider.auth);
const setAccepting = (body: object) =>
  request(app).patch('/api/v1/provider/accepting').set('Authorization', provider.auth).send(body);
const later = (ms: number) => new Date(Date.now() + ms).toISOString();

beforeEach(async () => {
  world = await createBookingWorld(app);
  patient = await world.newPatient();
  provider = await world.newProvider();
});

describe('reply countdown', () => {
  it('a waiting request carries respond_by and the seconds left by the server clock; null once answered', async () => {
    const id = (await world.book(patient, provider)).body.data.id;
    const stored = (await BookingModel.findById(id).lean())!;
    const item = (await get('/provider/bookings')).body.data.find((b: { id: string }) => b.id === id);
    expect(item.respond_by).toBe(stored.assignmentDeadline!.toISOString());
    expect(item.seconds_remaining).toBeGreaterThan(150);
    expect(item.seconds_remaining).toBeLessThanOrEqual(180);
    expect((await get(`/provider/bookings/${id}`)).body.data.respond_by).toBe(item.respond_by);
    expect((await get('/provider/home')).body.data.pending_requests[0].seconds_remaining).toEqual(
      expect.any(Number),
    );

    await world.providerApi(provider, 'post', `/bookings/${id}/accept`).expect(200);
    expect((await get(`/provider/bookings/${id}`)).body.data).toMatchObject({
      respond_by: null,
      seconds_remaining: null,
    });
  });
});

describe('pause until', () => {
  it('"end_of_day" pauses until the next Cairo midnight; a past time, more than 7 days, or with accepting on is refused', async () => {
    const res = await setAccepting({ is_accepting_bookings: false, resumes_at: 'end_of_day' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      is_accepting_bookings: false,
      accepting_resumes_at: cairoToUtc(addDays(cairoDate(), 1), '00:00').toISOString(),
    });
    for (const body of [
      { is_accepting_bookings: false, resumes_at: later(-60_000) },
      { is_accepting_bookings: false, resumes_at: later(8 * 24 * 3600_000) },
      { is_accepting_bookings: true, resumes_at: 'end_of_day' },
    ]) {
      expect((await setAccepting(body)).body.error.fields, JSON.stringify(body)).toHaveProperty('resumes_at');
    }
    // Turning accepting back on by hand clears the pending resume.
    expect((await setAccepting({ is_accepting_bookings: true })).body.data).toMatchObject({
      is_accepting_bookings: true,
      accepting_resumes_at: null,
    });
  });

  it('accepting comes back by itself when the time comes, with a notice; never for a provider suspended since', async () => {
    const sweep = () => Container.get(ProviderProfileService).resumeDue();
    await setAccepting({ is_accepting_bookings: false, resumes_at: 'end_of_day' }).expect(200);
    await ProviderProfileModel.updateOne(
      { _id: provider.id },
      { acceptingResumesAt: new Date(Date.now() - 1000) },
    );
    expect(await sweep()).toBe(1);
    expect((await ProviderProfileModel.findById(provider.id).lean())!).toMatchObject({
      isAcceptingBookings: true,
      acceptingResumesAt: null,
    });
    expect(await NotificationModel.exists({ userId: provider.userId, type: 'account' })).toBeTruthy();

    await setAccepting({ is_accepting_bookings: false, resumes_at: 'end_of_day' }).expect(200);
    await ProviderProfileModel.updateOne(
      { _id: provider.id },
      { acceptingResumesAt: new Date(Date.now() - 1000), verificationStatus: 'suspended' },
    );
    expect(await sweep()).toBe(0);
    expect((await ProviderProfileModel.findById(provider.id).lean())!).toMatchObject({
      isAcceptingBookings: false,
      acceptingResumesAt: null,
    });
  });
});
