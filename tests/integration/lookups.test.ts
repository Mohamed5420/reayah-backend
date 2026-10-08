import request from 'supertest';
import { Container } from 'typedi';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app';
import { useTestDatabase } from '../helpers/db';
import { runSeeds } from '../../src/database/seed';
import { GovernorateModel } from '../../src/database/models/location/governorate.model';
import { SettingsService } from '../../src/services/settings';
import { LOCATIONS_CACHE } from '../../src/services/location';
import { invalidateCacheNamespace } from '../../src/utils/cache/cache';

useTestDatabase();
const app = createTestApp();

beforeEach(async () => {
  await runSeeds();
});

const governorateId = async (nameAr: string) => String((await GovernorateModel.findOne({ nameAr }))!._id);

describe('GET /governorates', () => {
  it('lists active governorates in launch order, publicly cacheable', async () => {
    const res = await request(app).get('/api/v1/governorates');
    expect(res.status).toBe(200);
    expect(res.body.data.map((g: { name: string }) => g.name)).toEqual(['القاهرة', 'الجيزة', 'الإسكندرية']);
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.headers.vary).toContain('Accept-Language');
  });

  it('answers in English when asked and the English name exists', async () => {
    const res = await request(app).get('/api/v1/governorates').set('Accept-Language', 'en');
    expect(res.body.data[0].name).toBe('Cairo');
  });
});

describe('GET /governorates/:id/areas', () => {
  it('lists the areas of a governorate, alphabetically in Arabic', async () => {
    const res = await request(app).get(`/api/v1/governorates/${await governorateId('الجيزة')}/areas`);
    expect(res.status).toBe(200);
    const names = res.body.data.map((a: { name: string }) => a.name);
    expect(names).toContain('الدقي');
    expect(names).toEqual([...names].sort((a: string, b: string) => a.localeCompare(b, 'ar')));
    expect(res.body.data[0]).toEqual({
      id: expect.any(String),
      name: expect.any(String),
      governorate_id: expect.any(String),
    });
  });

  it('404s for an inactive governorate', async () => {
    const id = await governorateId('الإسكندرية');
    await GovernorateModel.updateOne({ _id: id }, { isActive: false });
    const res = await request(app).get(`/api/v1/governorates/${id}/areas`);
    expect(res.status).toBe(404);
    expect(res.body.error).toEqual({ code: 'NOT_FOUND', message: 'المحافظة غير موجودة' });
  });
});

describe('GET /areas', () => {
  it.each([
    ['مدينه نصر', 'مدينة نصر'],
    ['المعادى', 'المعادي'],
    ['nasr', 'مدينة نصر'],
  ])('finds "%s" → %s', async (search, expected) => {
    const res = await request(app).get('/api/v1/areas').query({ search });
    expect(res.status).toBe(200);
    expect(res.body.data.map((a: { name: string }) => a.name)).toContain(expected);
  });

  it('includes the governorate name and paginates', async () => {
    const res = await request(app).get('/api/v1/areas').query({ per_page: 5 });
    expect(res.body.data).toHaveLength(5);
    expect(res.body.data[0].governorate_name).toEqual(expect.any(String));
    expect(res.body.meta).toMatchObject({ per_page: 5, total: 48 });
  });

  it('filters by governorate and hides areas of inactive governorates', async () => {
    const giza = await governorateId('الجيزة');
    const inGiza = await request(app).get('/api/v1/areas').query({ governorate_id: giza, per_page: 100 });
    expect(inGiza.body.meta.total).toBe(11);

    // Direct DB write: clear the cache the way the admin service does after its writes.
    await GovernorateModel.updateOne({ _id: giza }, { isActive: false });
    await invalidateCacheNamespace(LOCATIONS_CACHE);
    const after = await request(app).get('/api/v1/areas').query({ per_page: 100 });
    expect(after.body.meta.total).toBe(48 - 11);
  });

  it('treats regex characters in the search as plain text', async () => {
    const res = await request(app).get('/api/v1/areas').query({ search: '.*' });
    expect(res.status).toBe(200);
    expect(res.body.meta.total).toBe(0);
  });
});

describe('catalog', () => {
  it('lists only active categories (Phase 1: nursing)', async () => {
    const res = await request(app).get('/api/v1/service-categories');
    expect(res.body.data).toEqual([
      { id: expect.any(String), key: 'nursing', name: 'تمريض منزلي', icon_url: null },
    ]);
  });

  it('lists services with the spec shape and filters by provider type', async () => {
    const res = await request(app).get('/api/v1/services');
    expect(res.body.data).toHaveLength(9);
    expect(res.body.data[0]).toMatchObject({
      name: 'غيار على جرح',
      provider_type: 'nurse',
      pricing_unit: 'per_visit',
      default_duration_minutes: 45,
      starting_price: null,
      currency: 'EGP',
    });

    const doctors = await request(app).get('/api/v1/services').query({ provider_type: 'doctor' });
    expect(doctors.body.data).toEqual([]);
  });

  it('returns one service, 404 for unknown ids', async () => {
    const list = await request(app).get('/api/v1/services');
    const one = await request(app).get(`/api/v1/services/${list.body.data[0].id}`);
    expect(one.body.data).toEqual(list.body.data[0]);

    const missing = await request(app).get('/api/v1/services/665f1c2b9e1d2a4c3b9e8f1a');
    expect(missing.status).toBe(404);
    expect(missing.body.error.message).toBe('الخدمة غير موجودة');
  });
});

describe('GET /app-config', () => {
  it('serves settings-driven config with the cancellation policy text', async () => {
    const res = await request(app).get('/api/v1/app-config');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      min_app_version: { android: '1.0.0', ios: '1.0.0' },
      support_phone: '',
      emergency_number: '123',
      cancellation_free_window_hours: 3,
      cancellation_policy: 'إلغاء مجاني حتى 3 ساعات قبل الموعد',
      direct_request_response_minutes: 3,
      features: { video_consult: false, card_payment: false, packages: false, clinic_visits: false },
    });
    expect(res.headers['cache-control']).toBe('public, max-age=60');
  });

  it('reflects admin setting changes', async () => {
    await Container.get(SettingsService).update({ cancellation_free_window_hours: 6 }, { actorId: null });
    const res = await request(app).get('/api/v1/app-config');
    expect(res.body.data.cancellation_policy).toBe('إلغاء مجاني حتى 6 ساعات قبل الموعد');
  });
});
