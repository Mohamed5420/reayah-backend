import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app';
import { useTestDatabase } from '../helpers/db';
import {
  createBookingWorld,
  tomorrowAt,
  type BookingWorld,
  type TestPatient,
  type TestProvider,
} from '../helpers/booking-world';
import { BookingModel } from '../../src/database/models/booking/booking.model';
import { addDays, cairoDate } from '../../src/utils/time/cairo';

/** Provider app (M21): a break kept around home visits and a daily maximum of home visits. */

useTestDatabase();
const app = createTestApp();

let world: BookingWorld;
let patient: TestPatient;
let provider: TestProvider;

const schedule = (body?: object) =>
  body
    ? request(app).put('/api/v1/provider/availability').set('Authorization', provider.auth).send(body)
    : request(app).get('/api/v1/provider/availability').set('Authorization', provider.auth);
const weekdays = Array.from({ length: 7 }, (_, d) => ({
  day_of_week: d,
  start_time: '09:00',
  end_time: '17:00',
}));
const slotsTomorrow = async () =>
  (
    await request(app)
      .get(`/api/v1/providers/${provider.id}/slots`)
      .query({ service_id: world.wound, date: addDays(cairoDate(), 1) })
      .set('Authorization', patient.auth)
  ).body.data.slots as Array<{ start: string; available: boolean }>;

beforeEach(async () => {
  world = await createBookingWorld(app);
  patient = await world.newPatient();
  provider = await world.newProvider();
});

describe('schedule rules', () => {
  it('defaults to a 15-minute break and no daily limit; values are checked and unknown fields refused', async () => {
    expect((await schedule()).body.data).toMatchObject({ break_minutes: 15, max_visits_per_day: null });
    const saved = await schedule({ slots: weekdays, break_minutes: 30, max_visits_per_day: 6 });
    expect(saved.body.data).toMatchObject({ break_minutes: 30, max_visits_per_day: 6 });
    // Omitted rules keep their values; null removes the limit.
    expect((await schedule({ slots: weekdays })).body.data.break_minutes).toBe(30);
    expect(
      (await schedule({ slots: weekdays, max_visits_per_day: null })).body.data.max_visits_per_day,
    ).toBeNull();
    for (const body of [
      { slots: weekdays, break_minutes: 121 },
      { slots: weekdays, max_visits_per_day: 0 },
      { slots: weekdays, rest_between_visits: 20 },
    ]) {
      expect((await schedule(body)).status, JSON.stringify(body)).toBe(422);
    }
  });

  it('the break keeps time free after a home visit, in slots and when booking', async () => {
    await schedule({ slots: weekdays, break_minutes: 60 }).expect(200);
    const id = (await world.book(patient, provider)).body.data.id;
    const end = (await BookingModel.findById(id).lean())!.scheduledEnd;
    // The first slot starting at or after the visit's end falls inside the break.
    const next = (await slotsTomorrow()).find((s) => new Date(s.start) >= end)!;
    expect(next.available).toBe(false);
    const other = await world.newPatient();
    expect((await world.book(other, provider, { scheduled_start: next.start })).status).not.toBe(201);

    await schedule({ slots: weekdays, break_minutes: 0 }).expect(200);
    expect((await slotsTomorrow()).find((s) => s.start === next.start)!.available).toBe(true);
    expect((await world.book(other, provider, { scheduled_start: next.start })).status).toBe(201);
  });

  it('once the daily maximum is reached that day offers nothing more; other days are unaffected', async () => {
    await schedule({ slots: weekdays, max_visits_per_day: 1 }).expect(200);
    expect((await world.book(patient, provider)).status).toBe(201);
    expect((await slotsTomorrow()).some((s) => s.available)).toBe(false);
    const other = await world.newPatient();
    expect((await world.book(other, provider, { scheduled_start: tomorrowAt('14:00') })).status).not.toBe(
      201,
    );
    const dayAfter = new Date(new Date(tomorrowAt('14:00')).getTime() + 24 * 3600_000).toISOString();
    expect((await world.book(other, provider, { scheduled_start: dayAfter })).status).toBe(201);
  });
});
