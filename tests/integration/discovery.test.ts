import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app';
import { useTestDatabase } from '../helpers/db';
import { createBookableProvider, createUserWithToken } from '../helpers/fixtures';
import { runSeeds } from '../../src/database/seed';
import { AreaModel } from '../../src/database/models/location/area.model';
import { CatalogServiceModel } from '../../src/database/models/catalog/catalog-service.model';
import { ProviderTimeOffModel } from '../../src/database/models/provider/provider-time-off.model';
import { Gender, UserRole, UserStatus, VerificationStatus } from '../../src/interfaces/enums';
import { addDays, cairoDate, cairoToUtc } from '../../src/utils/time/cairo';
import { invalidateCacheNamespace } from '../../src/utils/cache/cache';
import { LOCATIONS_CACHE } from '../../src/services/location';

useTestDatabase();
const app = createTestApp();

let patient: string;
let nasrCity: string;
let maadi: string;
let wound: string;
let injection: string;
const tomorrow = () => addDays(cairoDate(), 1);

beforeEach(async () => {
  await runSeeds();
  ({ auth: patient } = await createUserWithToken(UserRole.PATIENT));
  nasrCity = String((await AreaModel.findOne({ nameAr: 'مدينة نصر' }))!._id);
  maadi = String((await AreaModel.findOne({ nameAr: 'المعادي' }))!._id);
  wound = String((await CatalogServiceModel.findOne({ nameAr: 'غيار على جرح' }))!._id);
  injection = String((await CatalogServiceModel.findOne({ nameAr: 'حقن عضل أو وريد' }))!._id);
});

const search = (query: Record<string, string | number> = {}, token = patient) =>
  request(app)
    .get('/api/v1/providers')
    .query({ service_id: wound, area_id: nasrCity, ...query })
    .set('Authorization', token);
const ids = (res: request.Response) => res.body.data.map((p: { id: string }) => p.id);

const nurse = (
  overrides: Parameters<typeof createBookableProvider>[0] extends infer O ? Partial<O> : never = {},
) =>
  createBookableProvider({
    areaIds: [nasrCity],
    services: [{ serviceId: wound, price: 25000 }],
    ...overrides,
  });

describe('GET /providers — who is eligible', () => {
  it('only approved, accepting providers with an active account who cover the area and offer the service', async () => {
    const eligible = await nurse({ travelFee: 3000 });
    await nurse({ overrides: { isAcceptingBookings: false } });
    await nurse({ overrides: { verificationStatus: VerificationStatus.PENDING } });
    await nurse({ areaIds: [maadi] });
    await nurse({ services: [{ serviceId: injection, price: 15000 }] });
    await nurse({ userOverrides: { status: UserStatus.SUSPENDED } });

    const res = await search();
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([eligible.id]);
    expect(res.body.meta.total).toBe(1);
    expect(res.body.data[0]).toMatchObject({
      name: 'منى حسن',
      type: 'nurse',
      gender: 'female',
      is_verified: true,
      price: 25000,
      travel_fee: 3000,
      currency: 'EGP',
      pricing_unit: 'per_visit',
      organization: null,
      next_available: expect.any(String),
    });
  });

  it('refuses inactive areas and unknown services', async () => {
    await AreaModel.updateOne({ _id: maadi }, { isActive: false });
    await invalidateCacheNamespace(LOCATIONS_CACHE);
    const area = await search({ area_id: maadi });
    expect(area.status).toBe(422);
    expect(area.body.error.code).toBe('AREA_NOT_COVERED');

    expect((await search({ service_id: '665f1c2b9e1d2a4c3b9e8f1a' })).status).toBe(404);
  });
});

describe('GET /providers — filters and sorting', () => {
  let mona: string;
  let ahmed: string;

  beforeEach(async () => {
    mona = (await nurse({ gender: Gender.FEMALE, ratingAvg: 4.8, yearsOfExperience: 5 })).id;
    ahmed = (
      await nurse({
        gender: Gender.MALE,
        ratingAvg: 4.2,
        yearsOfExperience: 15,
        services: [{ serviceId: wound, price: 18000 }],
      })
    ).id;
  });

  it.each([
    [{}, () => [mona, ahmed]],
    [{ sort: 'price_asc' }, () => [ahmed, mona]],
    [{ sort: 'price_desc' }, () => [mona, ahmed]],
    [{ sort: 'experience' }, () => [ahmed, mona]],
    [{ gender: 'female' }, () => [mona]],
    [{ gender: 'male' }, () => [ahmed]],
    [{ min_price: 20000 }, () => [mona]],
    [{ max_price: 20000 }, () => [ahmed]],
    [{ min_rating: 4.5 }, () => [mona]],
    [{ provider_type: 'doctor' }, () => []],
    [{ source: 'organization' }, () => []],
  ])('%o', async (query, expected) => {
    expect(ids(await search(query))).toEqual(expected());
  });
});

describe('GET /providers — date and time', () => {
  it('with a date, keeps only providers who have a free slot that day', async () => {
    const free = await nurse();
    const away = await nurse();
    await ProviderTimeOffModel.create({
      providerProfileId: away.profile._id,
      startsAt: cairoToUtc(tomorrow(), '00:00'),
      endsAt: cairoToUtc(addDays(tomorrow(), 1), '00:00'),
    });

    expect(ids(await search({ date: tomorrow() }))).toEqual([free.id]);
    // Without a date both are listed; the one on leave just has a later next_available.
    expect((await search()).body.meta.total).toBe(2);
  });

  it('with a time, the slot must start then', async () => {
    const provider = await nurse();
    expect(ids(await search({ date: tomorrow(), time: '09:00' }))).toEqual([provider.id]);
    expect(ids(await search({ date: tomorrow(), time: '08:00' }))).toEqual([]);
    const res = await search({ date: tomorrow(), time: '09:00' });
    expect(res.body.data[0].next_available).toBe(cairoToUtc(tomorrow(), '09:00').toISOString());
  });

  it('validates the date range and requires a date with a time', async () => {
    expect((await search({ time: '09:00' })).body.error.fields).toEqual({ time: ['حدد التاريخ مع الوقت'] });
    expect((await search({ date: addDays(cairoDate(), -1) })).status).toBe(422);
    expect((await search({ date: addDays(cairoDate(), 61) })).status).toBe(422);
  });
});

describe('GET /providers/{id}', () => {
  it('shows the public profile without identity data', async () => {
    const provider = await nurse({
      overrides: { bio: 'خبرة في رعاية كبار السن', licenseNumber: 'LIC-SECRET-1', languages: ['ar'] },
    });
    const res = await request(app).get(`/api/v1/providers/${provider.id}`).set('Authorization', patient);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      name: 'منى حسن',
      bio: 'خبرة في رعاية كبار السن',
      is_accepting_bookings: true,
      service_areas: [{ id: nasrCity, name: 'مدينة نصر' }],
      services: [{ service_id: wound, name: 'غيار على جرح', price: 25000, pricing_unit: 'per_visit' }],
      recent_reviews: [],
    });
    expect(JSON.stringify(res.body)).not.toContain('LIC-SECRET-1');
  });

  it('404 for providers who aren’t approved', async () => {
    const pending = await nurse({ overrides: { verificationStatus: VerificationStatus.PENDING } });
    expect(
      (await request(app).get(`/api/v1/providers/${pending.id}`).set('Authorization', patient)).status,
    ).toBe(404);
  });

  it('reviews: an empty page until reviews exist (M1.8)', async () => {
    const provider = await nurse();
    const res = await request(app)
      .get(`/api/v1/providers/${provider.id}/reviews`)
      .set('Authorization', patient);
    expect(res.body).toEqual({ data: [], meta: { page: 1, per_page: 20, total: 0, last_page: 1 } });
  });
});

describe('GET /providers/{id}/slots', () => {
  const slots = (id: string, query: Record<string, string | number> = {}) =>
    request(app)
      .get(`/api/v1/providers/${id}/slots`)
      .query({ service_id: wound, date: tomorrow(), ...query })
      .set('Authorization', patient);

  it('lists 45-minute visits every 30 minutes inside working hours, marking time off', async () => {
    const provider = await nurse();
    await ProviderTimeOffModel.create({
      providerProfileId: provider.profile._id,
      startsAt: cairoToUtc(tomorrow(), '10:00'),
      endsAt: cairoToUtc(tomorrow(), '11:00'),
    });
    const res = await slots(provider.id);
    expect(res.status).toBe(200);
    const list = res.body.data.slots as Array<{ start: string; available: boolean }>;
    // 09:00 … 16:00 Cairo (16:00 + 45 min still ends by 17:00)
    expect(list).toHaveLength(15);
    expect(list[0].start).toBe(cairoToUtc(tomorrow(), '09:00').toISOString());
    expect(list.filter((s) => !s.available).map((s) => s.start)).toEqual(
      ['09:30', '10:00', '10:30'].map((t) => cairoToUtc(tomorrow(), t).toISOString()),
    );
  });

  it('validates service, date and quantity', async () => {
    const provider = await nurse();
    expect((await slots(provider.id, { service_id: injection })).body.error.message).toBe(
      'مقدم الخدمة لا يقدم هذه الخدمة',
    );
    expect((await slots(provider.id, { date: addDays(cairoDate(), -1) })).status).toBe(422);
    expect((await slots(provider.id, { quantity: 2 })).body.error.fields).toEqual({
      quantity: ['الكمية غير مسموحة لهذه الخدمة'],
    });
  });
});

describe('GET /home', () => {
  it('greets the patient and lists categories', async () => {
    const res = await request(app).get('/api/v1/home').set('Authorization', patient);
    expect(res.body.data).toEqual({
      greeting_name: 'منى',
      categories: [{ id: expect.any(String), key: 'nursing', name: 'تمريض منزلي', icon_url: null }],
      upcoming_booking: null,
      active_package: null,
      banners: [],
    });
  });

  it('is for patients only', async () => {
    const { auth } = await createUserWithToken(UserRole.PROVIDER);
    expect((await request(app).get('/api/v1/home').set('Authorization', auth)).status).toBe(403);
  });
});
