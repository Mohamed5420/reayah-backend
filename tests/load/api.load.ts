import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { Server } from '../../src/server';
import { getGlobalControllers } from '../../src/api/controllers';
import { useTestDatabase } from '../helpers/db';
import { signTestToken } from '../helpers/app';
import { seedStaging } from '../../src/database/seed/staging';
import { UserModel } from '../../src/database/models/user/user.model';
import { AddressModel } from '../../src/database/models/patient/address.model';
import { PatientProfileModel } from '../../src/database/models/patient/patient-profile.model';
import { ProviderProfileModel } from '../../src/database/models/provider/provider-profile.model';
import { UserRole } from '../../src/interfaces/enums';
import { addDays, cairoDate, cairoToUtc } from '../../src/utils/time/cairo';

/**
 * M1.9 load test: p95 of the main read endpoints must stay under 300 ms (spec §10) on a staging-sized
 * dataset, and the booking write path must hold up under concurrency without double bookings.
 * Runs the real app over HTTP (JSON, compression, auth, validation, Mongo, cache) — only Redis is the
 * in-memory mock and MongoDB the in-memory replica set, so absolute numbers are indicative; re-run
 * against staging with the same scenarios once it exists.
 */

useTestDatabase();

const PROVIDERS = Number(process.env.LOAD_PROVIDERS ?? 1000);
/** 10 clients with no think time ≈ a busy instance; search saturates one process at ~55–75 req/s. */
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 10);
const REQUESTS = Number(process.env.LOAD_REQUESTS ?? 400);
const P95_TARGET_MS = 300;

type Result = {
  scenario: string;
  requests: number;
  errors: number;
  p50: number;
  p95: number;
  p99: number;
  rps: number;
};

const percentile = (sorted: number[], p: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : 0;

/** Runs `count` calls of `call(i)` with `concurrency` in flight; a call returns whether it succeeded. */
const run = async (
  scenario: string,
  count: number,
  call: (i: number) => Promise<boolean>,
): Promise<Result> => {
  const latencies: number[] = [];
  let errors = 0;
  let next = 0;
  const started = performance.now();
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < count) {
        const i = next++;
        const t0 = performance.now();
        const ok = await call(i).catch(() => false);
        latencies.push(performance.now() - t0);
        if (!ok) errors++;
      }
    }),
  );
  const seconds = (performance.now() - started) / 1000;
  latencies.sort((a, b) => a - b);
  const round = (n: number) => Math.round(n);
  return {
    scenario,
    requests: count,
    errors,
    p50: round(percentile(latencies, 50)),
    p95: round(percentile(latencies, 95)),
    p99: round(percentile(latencies, 99)),
    rps: round(count / seconds),
  };
};

describe(`load: ${PROVIDERS} providers, ${CONCURRENCY} concurrent clients`, () => {
  let base = '';
  const patients: Array<{ auth: string; profileId: string; addressId: string; areaId: string }> = [];
  let providers: Array<{ id: string; areaIds: string[]; serviceId: string }> = [];

  beforeAll(async () => {
    const t0 = performance.now();
    const seeded = await seedStaging({ providers: PROVIDERS, doctors: 0, patients: 100, bookings: 0 });
    console.log(`Seeded in ${Math.round((performance.now() - t0) / 1000)} s:`, seeded);

    const server = new Server(getGlobalControllers());
    await new Promise<void>((resolve) => server.httpServer.listen(0, resolve));
    base = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}/api/v1`;

    for (const user of await UserModel.find({ role: UserRole.PATIENT }).lean()) {
      const profile = await PatientProfileModel.findOne({ ownerUserId: user._id }).lean();
      const address = await AddressModel.findOne({ userId: user._id }).lean();
      patients.push({
        auth: `Bearer ${signTestToken({ id: String(user._id), role: UserRole.PATIENT })}`,
        profileId: String(profile!._id),
        addressId: String(address!._id),
        areaId: String(address!.areaId),
      });
    }
    providers = (await ProviderProfileModel.find({ isAcceptingBookings: true }).lean()).map((p) => ({
      id: String(p._id),
      areaIds: p.serviceAreas.map((a) => String(a.areaId)),
      serviceId: String(p.services[0].serviceId),
    }));
  });

  it('read p95 under 300 ms; concurrent bookings never double-book', async () => {
    const tomorrow = addDays(cairoDate(), 1);
    const get = async (path: string, auth: string) =>
      (await fetch(base + path, { headers: { Authorization: auth } })).ok;
    const patientAt = (i: number) => patients[i % patients.length];
    const providerAt = (i: number) => providers[(i * 7) % providers.length];
    // Search the area + service of a real provider so results aren't empty.
    const searchFor = (i: number, extra = '') => {
      const p = providerAt(i);
      return `/providers?area_id=${p.areaIds[0]}&service_id=${p.serviceId}${extra}`;
    };

    const results: Result[] = [];
    results.push(await run('GET /home', REQUESTS, (i) => get('/home', patientAt(i).auth)));
    results.push(
      await run('GET /providers (area + service)', REQUESTS, (i) => get(searchFor(i), patientAt(i).auth)),
    );
    results.push(
      await run('GET /providers (+ date)', REQUESTS, (i) =>
        get(searchFor(i, `&date=${tomorrow}`), patientAt(i).auth),
      ),
    );
    results.push(
      await run('GET /providers (+ date + time)', REQUESTS, (i) =>
        get(searchFor(i, `&date=${tomorrow}&time=10:00`), patientAt(i).auth),
      ),
    );
    results.push(
      await run('GET /providers/{id}', REQUESTS, (i) =>
        get(`/providers/${providerAt(i).id}`, patientAt(i).auth),
      ),
    );
    results.push(
      await run('GET /providers/{id}/slots', REQUESTS, (i) =>
        get(
          `/providers/${providerAt(i).id}/slots?service_id=${providerAt(i).serviceId}&date=${tomorrow}`,
          patientAt(i).auth,
        ),
      ),
    );
    results.push(
      await run('GET /bookings', REQUESTS, (i) => get('/bookings?scope=upcoming', patientAt(i).auth)),
    );

    // Write path: quote + book. Every request targets one of 10 providers at 10:00 tomorrow, so most
    // compete for the same slot — exactly one booking per provider/slot may win.
    const contested = providers.slice(0, 10);
    const bookingResults: number[] = [];
    const book = async (i: number) => {
      const provider = contested[i % contested.length];
      const patient = patients.find((p) => provider.areaIds.includes(p.areaId));
      if (!patient) return false;
      const quote = await fetch(`${base}/bookings/quote`, {
        method: 'POST',
        headers: { Authorization: patient.auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          service_id: provider.serviceId,
          provider_id: provider.id,
          patient_profile_id: patient.profileId,
          address_id: patient.addressId,
          scheduled_start: cairoToUtc(tomorrow, '10:00').toISOString(),
        }),
      });
      if (!quote.ok) {
        bookingResults.push(quote.status);
        return quote.status === 409; // slot already gone: a correct answer
      }
      const { data } = (await quote.json()) as { data: { quote_token: string } };
      const created = await fetch(`${base}/bookings`, {
        method: 'POST',
        headers: {
          Authorization: patient.auth,
          'Content-Type': 'application/json',
          'Idempotency-Key': randomUUID(),
        },
        body: JSON.stringify({ quote_token: data.quote_token, payment_method: 'cash' }),
      });
      bookingResults.push(created.status);
      return created.status === 201 || created.status === 409;
    };
    const writes = await run('POST quote + /bookings (contested)', Math.min(REQUESTS, 200), book);

    console.table([...results, writes]);

    for (const r of results) {
      expect(r.errors, r.scenario).toBe(0);
      expect(r.p95, r.scenario).toBeLessThan(P95_TARGET_MS);
    }
    expect(writes.errors, 'booking write errors (other than 409)').toBe(0);
    // No double booking: at most one active booking per contested provider at 10:00.
    const { BookingModel } = await import('../../src/database/models/booking/booking.model');
    const perProvider = await BookingModel.aggregate<{ _id: string; n: number }>([
      { $match: { scheduledStart: cairoToUtc(tomorrow, '10:00'), status: { $in: ['pending', 'accepted'] } } },
      { $group: { _id: '$providerProfileId', n: { $sum: 1 } } },
    ]);
    expect(perProvider.every((p) => p.n === 1)).toBe(true);
    expect(bookingResults.filter((s) => s === 201).length).toBe(perProvider.length);
  });
});
