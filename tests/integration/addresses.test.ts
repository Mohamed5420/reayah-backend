import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app';
import { useTestDatabase } from '../helpers/db';
import { createUserWithToken } from '../helpers/fixtures';
import { runSeeds } from '../../src/database/seed';
import { AreaModel } from '../../src/database/models/location/area.model';
import { GovernorateModel } from '../../src/database/models/location/governorate.model';
import { UserRole } from '../../src/interfaces/enums';
import { invalidateCacheNamespace } from '../../src/utils/cache/cache';
import { LOCATIONS_CACHE } from '../../src/services/location';

useTestDatabase();
const app = createTestApp();

let auth: string;
let cairo: string;
let nasrCity: string;
let maadi: string;
let dokki: string;

beforeEach(async () => {
  await runSeeds();
  ({ auth } = await createUserWithToken());
  cairo = String((await GovernorateModel.findOne({ nameAr: 'القاهرة' }))!._id);
  nasrCity = String((await AreaModel.findOne({ nameAr: 'مدينة نصر' }))!._id);
  maadi = String((await AreaModel.findOne({ nameAr: 'المعادي' }))!._id);
  dokki = String((await AreaModel.findOne({ nameAr: 'الدقي' }))!._id);
});

const body = (overrides: Record<string, unknown> = {}) => ({
  label: 'بيت بابا',
  governorate_id: cairo,
  area_id: nasrCity,
  street: 'شارع عباس العقاد',
  building: '15',
  floor: '4',
  apartment: '12',
  landmark: 'بجوار صيدلية العزبي',
  ...overrides,
});
const create = (overrides: Record<string, unknown> = {}) =>
  request(app).post('/api/v1/addresses').set('Authorization', auth).send(body(overrides));

describe('addresses', () => {
  it('creates a text-only address with names and a one-line full text; the first is the default', async () => {
    const res = await create();
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      label: 'بيت بابا',
      governorate: { id: cairo, name: 'القاهرة' },
      area: { id: nasrCity, name: 'مدينة نصر' },
      is_default: true,
      is_bookable: true,
      full_text: '15 شارع عباس العقاد، الدور 4، شقة 12، مدينة نصر، القاهرة',
    });
  });

  it('refuses coordinates (and any other unknown field) by name', async () => {
    const res = await create({ lat: 30.05, lng: 31.33, location: { type: 'Point' } });
    expect(res.status).toBe(422);
    expect(res.body.error.fields).toEqual({
      lat: ['هذا الحقل غير مسموح'],
      lng: ['هذا الحقل غير مسموح'],
      location: ['هذا الحقل غير مسموح'],
    });
  });

  it('requires a bookable area inside the chosen governorate', async () => {
    const mismatch = await create({ area_id: dokki }); // Dokki is in Giza
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.error.fields).toEqual({ governorate_id: ['المنطقة لا تتبع المحافظة المختارة'] });

    await AreaModel.updateOne({ _id: maadi }, { isActive: false });
    const inactive = await create({ area_id: maadi });
    expect(inactive.status).toBe(422);
    expect(inactive.body.error.fields).toEqual({ area_id: ['الخدمة غير متاحة في هذه المنطقة حالياً'] });
  });

  it('keeps exactly one default', async () => {
    const first = await create();
    const second = await create({ label: 'الشغل', is_default: true });
    expect(second.body.data.is_default).toBe(true);

    const list = await request(app).get('/api/v1/addresses').set('Authorization', auth);
    expect(
      list.body.data.map((a: { label: string; is_default: boolean }) => [a.label, a.is_default]),
    ).toEqual([
      ['الشغل', true],
      ['بيت بابا', false],
    ]);

    await request(app)
      .post(`/api/v1/addresses/${first.body.data.id}/default`)
      .set('Authorization', auth)
      .expect(200);
    const after = await request(app).get('/api/v1/addresses').set('Authorization', auth);
    expect(after.body.data[0]).toMatchObject({ label: 'بيت بابا', is_default: true });
    expect(after.body.data.filter((a: { is_default: boolean }) => a.is_default)).toHaveLength(1);
  });

  it('deleting the default promotes the newest remaining address', async () => {
    const first = await create({ label: 'أ' });
    await create({ label: 'ب' });
    await create({ label: 'ج' });
    await request(app)
      .delete(`/api/v1/addresses/${first.body.data.id}`)
      .set('Authorization', auth)
      .expect(204);

    const list = await request(app).get('/api/v1/addresses').set('Authorization', auth);
    expect(list.body.data.map((a: { label: string }) => a.label)).toEqual(['ج', 'ب']);
    expect(list.body.data[0].is_default).toBe(true);
  });

  it('updates fields and re-validates a moved address', async () => {
    const created = await create();
    const res = await request(app)
      .patch(`/api/v1/addresses/${created.body.data.id}`)
      .set('Authorization', auth)
      .send({ area_id: maadi, floor: '2', notes: null });
    expect(res.body.data).toMatchObject({ area: { name: 'المعادي' }, floor: '2' });

    const bad = await request(app)
      .patch(`/api/v1/addresses/${created.body.data.id}`)
      .set('Authorization', auth)
      .send({ area_id: dokki });
    expect(bad.status).toBe(422);
  });

  it('flags addresses whose area was deactivated later', async () => {
    await create();
    await AreaModel.updateOne({ _id: nasrCity }, { isActive: false });
    await invalidateCacheNamespace(LOCATIONS_CACHE);
    const list = await request(app).get('/api/v1/addresses').set('Authorization', auth);
    expect(list.body.data[0]).toMatchObject({ is_bookable: false, area: { name: 'مدينة نصر' } });
  });

  it('is private to its owner and to patients', async () => {
    const created = await create();
    const other = await createUserWithToken();
    const res = await request(app)
      .patch(`/api/v1/addresses/${created.body.data.id}`)
      .set('Authorization', other.auth)
      .send({ floor: '9' });
    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe('العنوان غير موجود');

    const provider = await createUserWithToken(UserRole.PROVIDER);
    expect((await request(app).get('/api/v1/addresses').set('Authorization', provider.auth)).status).toBe(
      403,
    );
  });
});
