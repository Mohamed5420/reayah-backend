import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app';
import { useTestDatabase } from '../helpers/db';
import { createUserWithToken } from '../helpers/fixtures';
import { runSeeds } from '../../src/database/seed';
import { GovernorateModel } from '../../src/database/models/location/governorate.model';
import { AreaModel } from '../../src/database/models/location/area.model';
import { ServiceCategoryModel } from '../../src/database/models/catalog/service-category.model';
import { CatalogServiceModel } from '../../src/database/models/catalog/catalog-service.model';
import { AuditLogModel } from '../../src/database/models/audit-log/audit-log.model';
import { UserRole } from '../../src/interfaces/enums';

useTestDatabase();
const app = createTestApp();

let admin: string;
let adminId: string;
let cairoId: string;

beforeEach(async () => {
  await runSeeds();
  ({ auth: admin, id: adminId } = await createUserWithToken(UserRole.ADMIN));
  cairoId = String((await GovernorateModel.findOne({ nameAr: 'القاهرة' }))!._id);
});

describe('admin access', () => {
  it('requires a token and the admin role', async () => {
    expect((await request(app).get('/api/v1/admin/areas')).status).toBe(401);

    for (const role of [UserRole.PATIENT, UserRole.PROVIDER, UserRole.OWNER]) {
      const { auth } = await createUserWithToken(role);
      const res = await request(app).get('/api/v1/admin/areas').set('Authorization', auth);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }

    expect((await request(app).get('/api/v1/admin/areas').set('Authorization', admin)).status).toBe(200);
  });
});

describe('areas', () => {
  it('deactivating an area removes it from public lookups at once, and is audited', async () => {
    const area = (await AreaModel.findOne({ nameAr: 'المعادي' }))!;
    const before = await request(app).get(`/api/v1/governorates/${cairoId}/areas`); // warms the cache
    expect(before.body.data.map((a: { name: string }) => a.name)).toContain('المعادي');

    const res = await request(app)
      .patch(`/api/v1/admin/areas/${area._id}`)
      .set('Authorization', admin)
      .send({ is_active: false, max_travel_fee: 5000 });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ name_ar: 'المعادي', is_active: false, max_travel_fee: 5000 });

    const after = await request(app).get(`/api/v1/governorates/${cairoId}/areas`);
    expect(after.body.data.map((a: { name: string }) => a.name)).not.toContain('المعادي');

    const audit = await AuditLogModel.findOne({ action: 'area.update', entityId: String(area._id) }).lean();
    expect(audit).toMatchObject({
      metadata: { changes: { isActive: { from: true, to: false }, maxTravelFee: { from: null, to: 5000 } } },
    });
    expect(String(audit!.actorId)).toBe(adminId);
  });

  it('creates an area (searchable right away) and rejects duplicates in the same governorate', async () => {
    const body = { governorate_id: cairoId, name_ar: 'القطامية', name_en: 'Katameya' };
    const created = await request(app).post('/api/v1/admin/areas').set('Authorization', admin).send(body);
    expect(created.status).toBe(201);

    const found = await request(app).get('/api/v1/areas').query({ search: 'القطاميه' });
    expect(found.body.data.map((a: { name: string }) => a.name)).toContain('القطامية');

    const duplicate = await request(app).post('/api/v1/admin/areas').set('Authorization', admin).send(body);
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error).toEqual({ code: 'CONFLICT', message: 'يوجد عنصر بنفس البيانات بالفعل' });
  });

  it('validates input: unknown governorate, negative fee, missing name', async () => {
    const res = await request(app)
      .post('/api/v1/admin/areas')
      .set('Authorization', admin)
      .send({ governorate_id: '665f1c2b9e1d2a4c3b9e8f1a', max_travel_fee: -1 });
    expect(res.status).toBe(422);
    expect(res.body.error.fields).toEqual({
      name_ar: ['هذا الحقل مطلوب'],
      max_travel_fee: ['قيمة غير صالحة'],
    });

    const unknownGov = await request(app)
      .post('/api/v1/admin/areas')
      .set('Authorization', admin)
      .send({ governorate_id: '665f1c2b9e1d2a4c3b9e8f1a', name_ar: 'منطقة' });
    expect(unknownGov.status).toBe(422);
    expect(unknownGov.body.error.fields).toEqual({ governorate_id: ['العنصر المحدد غير موجود'] });
  });

  it('lists with filters and pagination, including inactive areas', async () => {
    await AreaModel.updateOne({ nameAr: 'الزمالك' }, { isActive: false });
    const res = await request(app)
      .get('/api/v1/admin/areas')
      .query({ governorate_id: cairoId, is_active: 'false' })
      .set('Authorization', admin);
    expect(res.body.data.map((a: { name_ar: string }) => a.name_ar)).toEqual(['الزمالك']);
    expect(res.body.meta.total).toBe(1);
  });
});

describe('governorates', () => {
  it('deactivating a governorate hides it publicly', async () => {
    await request(app).get('/api/v1/governorates'); // warm cache
    await request(app)
      .patch(`/api/v1/admin/governorates/${cairoId}`)
      .set('Authorization', admin)
      .send({ is_active: false })
      .expect(200);
    const res = await request(app).get('/api/v1/governorates');
    expect(res.body.data.map((g: { name: string }) => g.name)).toEqual(['الجيزة', 'الإسكندرية']);
  });
});

describe('categories', () => {
  it('refuses to delete a category that still has services', async () => {
    const nursing = (await ServiceCategoryModel.findOne({ key: 'nursing' }))!;
    const res = await request(app)
      .delete(`/api/v1/admin/service-categories/${nursing._id}`)
      .set('Authorization', admin);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('deletes an empty category, after which its key can be reused', async () => {
    const packages = (await ServiceCategoryModel.findOne({ key: 'packages' }))!;
    await request(app)
      .delete(`/api/v1/admin/service-categories/${packages._id}`)
      .set('Authorization', admin)
      .expect(204);

    const list = await request(app).get('/api/v1/admin/service-categories').set('Authorization', admin);
    expect(list.body.data.map((c: { key: string }) => c.key)).not.toContain('packages');

    const recreated = await request(app)
      .post('/api/v1/admin/service-categories')
      .set('Authorization', admin)
      .send({ key: 'packages', name_ar: 'باقات الرعاية' });
    expect(recreated.status).toBe(201);
  });

  it('activating a category publishes it', async () => {
    const elderly = (await ServiceCategoryModel.findOne({ key: 'elderly_care' }))!;
    await request(app).get('/api/v1/service-categories'); // warm cache
    await request(app)
      .patch(`/api/v1/admin/service-categories/${elderly._id}`)
      .set('Authorization', admin)
      .send({ is_active: true })
      .expect(200);
    const res = await request(app).get('/api/v1/service-categories');
    expect(res.body.data.map((c: { key: string }) => c.key)).toEqual(['nursing', 'elderly_care']);
  });
});

describe('services', () => {
  const newService = async () => ({
    category_id: String((await ServiceCategoryModel.findOne({ key: 'nursing' }))!._id),
    name_ar: 'سحب عينة دم',
    provider_type: 'nurse',
    pricing_unit: 'per_visit',
    default_duration_minutes: 20,
  });

  it('creates a service that shows up in the public catalog', async () => {
    const res = await request(app)
      .post('/api/v1/admin/services')
      .set('Authorization', admin)
      .send({ ...(await newService()), min_price: 10000, max_price: 30000 });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ name_ar: 'سحب عينة دم', min_price: 10000, max_price: 30000 });

    const list = await request(app).get('/api/v1/services');
    expect(list.body.data.map((s: { name: string }) => s.name)).toContain('سحب عينة دم');
  });

  it('enforces max_price ≥ min_price, also against stored values on update', async () => {
    const bad = await request(app)
      .post('/api/v1/admin/services')
      .set('Authorization', admin)
      .send({ ...(await newService()), min_price: 30000, max_price: 10000 });
    expect(bad.status).toBe(422);
    expect(bad.body.error.fields).toEqual({
      max_price: ['الحد الأقصى يجب أن يكون أكبر من أو يساوي الحد الأدنى'],
    });

    const ok = await request(app)
      .post('/api/v1/admin/services')
      .set('Authorization', admin)
      .send({ ...(await newService()), max_price: 20000 });
    const update = await request(app)
      .patch(`/api/v1/admin/services/${ok.body.data.id}`)
      .set('Authorization', admin)
      .send({ min_price: 25000 });
    expect(update.status).toBe(422);
    expect((await CatalogServiceModel.findById(ok.body.data.id))!.minPrice).toBeNull();
  });

  it('DELETE deactivates: gone from the public catalog, still listed for admins', async () => {
    const service = (await CatalogServiceModel.findOne({ nameAr: 'غيار على جرح' }))!;
    await request(app).get(`/api/v1/services/${service._id}`).expect(200); // warm cache
    await request(app)
      .delete(`/api/v1/admin/services/${service._id}`)
      .set('Authorization', admin)
      .expect(204);

    expect((await request(app).get(`/api/v1/services/${service._id}`)).status).toBe(404);
    const admins = await request(app)
      .get('/api/v1/admin/services')
      .query({ is_active: 'false' })
      .set('Authorization', admin);
    expect(admins.body.data.map((s: { name_ar: string }) => s.name_ar)).toEqual(['غيار على جرح']);
  });
});
