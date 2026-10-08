import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app';
import { useTestDatabase } from '../helpers/db';
import { createUserWithToken, signUp } from '../helpers/fixtures';
import { sampleFiles, useFakeStorage } from '../helpers/storage';
import { runSeeds } from '../../src/database/seed';
import { AreaModel } from '../../src/database/models/location/area.model';
import { CatalogServiceModel } from '../../src/database/models/catalog/catalog-service.model';
import { ProviderProfileModel } from '../../src/database/models/provider/provider-profile.model';
import { ProviderDocumentModel } from '../../src/database/models/provider/provider-document.model';
import { AuditLogModel } from '../../src/database/models/audit-log/audit-log.model';
import { UserRole } from '../../src/interfaces/enums';
import { invalidateCacheNamespace } from '../../src/utils/cache/cache';
import { CATALOG_CACHE } from '../../src/services/catalog';
import { LOCATIONS_CACHE } from '../../src/services/location';

useTestDatabase();
useFakeStorage();
const app = createTestApp();

let provider: string;
let providerUserId: string;
let admin: string;
let nasrCity: string;
let maadi: string;
let woundDressing: string;
let injection: string;

beforeEach(async () => {
  await runSeeds();
  const session = await signUp(app, UserRole.PROVIDER);
  provider = `Bearer ${session.access_token}`;
  providerUserId = session.user.id;
  ({ auth: admin } = await createUserWithToken(UserRole.ADMIN));
  nasrCity = String((await AreaModel.findOne({ nameAr: 'مدينة نصر' }))!._id);
  maadi = String((await AreaModel.findOne({ nameAr: 'المعادي' }))!._id);
  woundDressing = String((await CatalogServiceModel.findOne({ nameAr: 'غيار على جرح' }))!._id);
  injection = String((await CatalogServiceModel.findOne({ nameAr: 'حقن عضل أو وريد' }))!._id);
});

const api = (method: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string, token = provider) =>
  request(app)[method](`/api/v1${path}`).set('Authorization', token);

const uploadDocument = async (type: string, token = provider) => {
  const upload = await request(app)
    .post('/api/v1/uploads')
    .set('Authorization', token)
    .field('purpose', 'provider_document')
    .attach('file', sampleFiles.jpeg, `${type}.jpg`);
  return api('post', '/provider/documents', token).send({ type, file_key: upload.body.data.file_key });
};

const completeOnboarding = async () => {
  await api('patch', '/provider/profile')
    .send({
      type: 'nurse',
      license_number: 'LIC-2020-555',
      syndicate_number: 'SYN-777',
      years_of_experience: 8,
    })
    .expect(200);
  for (const type of ['license', 'syndicate_card', 'national_id_front', 'national_id_back']) {
    expect((await uploadDocument(type)).status).toBe(201);
  }
  await api('put', '/provider/service-areas')
    .send({ areas: [{ area_id: nasrCity, travel_fee: 3000 }] })
    .expect(200);
  await api('put', '/provider/services')
    .send({ services: [{ service_id: woundDressing, price: 25000 }] })
    .expect(200);
  await api('put', '/provider/availability')
    .send({ slots: [{ day_of_week: 0, start_time: '09:00', end_time: '15:00' }] })
    .expect(200);
};

const profileId = async () => String((await ProviderProfileModel.findOne({ userId: providerUserId }))!._id);

describe('exit criterion: a nurse onboards, an admin approves, the nurse starts accepting bookings', () => {
  it('works end to end', async () => {
    const draft = await api('get', '/provider/profile');
    expect(draft.body.data).toMatchObject({
      verification_status: 'draft',
      onboarding: {
        profile_completed: false,
        documents_uploaded: false,
        areas_selected: false,
        services_set: false,
        availability_set: false,
        clinics_set: true,
        can_submit: false,
      },
    });

    await completeOnboarding();
    const ready = await api('get', '/provider/profile');
    expect(ready.body.data.onboarding).toEqual({
      profile_completed: true,
      documents_uploaded: true,
      areas_selected: true,
      services_set: true,
      availability_set: true,
      clinics_set: true,
      can_submit: true,
    });

    const early = await api('patch', '/provider/accepting').send({ is_accepting_bookings: true });
    expect(early.status).toBe(403);
    expect(early.body.error.code).toBe('PROVIDER_NOT_VERIFIED');

    const submitted = await api('post', '/provider/submit-verification');
    expect(submitted.body.data).toMatchObject({ status: 'pending', submitted_at: expect.any(String) });

    const queue = await api('get', '/admin/verifications', admin);
    expect(queue.body.data).toEqual([
      expect.objectContaining({
        id: await profileId(),
        provider_type: 'nurse',
        status: 'pending',
        documents_count: 4,
      }),
    ]);

    const detail = await api('get', `/admin/verifications/${await profileId()}`, admin);
    expect(detail.body.data).toMatchObject({
      license_number: 'LIC-2020-555',
      service_areas: [{ name: 'مدينة نصر', governorate_name: 'القاهرة', travel_fee: 3000 }],
      services: [{ name: 'غيار على جرح', price: 25000, is_available: true }],
      availability: [{ day_of_week: 0, start_time: '09:00', end_time: '15:00' }],
    });
    expect(detail.body.data.documents).toHaveLength(4);
    expect(detail.body.data.documents[0].file_url).toContain('X-Amz-Signature');

    const approved = await api('post', `/admin/verifications/${await profileId()}/approve`, admin);
    expect(approved.body.data.verification_status).toBe('approved');
    expect(approved.body.data.documents.every((d: { status: string }) => d.status === 'matching')).toBe(true);
    expect(await AuditLogModel.exists({ action: 'provider.approve' })).toBeTruthy();

    const accepting = await api('patch', '/provider/accepting').send({ is_accepting_bookings: true });
    expect(accepting.status).toBe(200);
    expect(accepting.body.data.is_accepting_bookings).toBe(true);

    // The approved, accepting nurse's price is now the service's starting price.
    const services = await request(app).get('/api/v1/services');
    const service = services.body.data.find((s: { id: string }) => s.id === woundDressing);
    expect(service.starting_price).toBe(25000);
  });
});

describe('submission', () => {
  it('lists every missing onboarding item', async () => {
    const res = await api('post', '/provider/submit-verification');
    expect(res.status).toBe(422);
    expect(Object.keys(res.body.error.fields)).toEqual([
      'profile',
      'documents',
      'service_areas',
      'services',
      'availability',
    ]);
    expect(res.body.error.fields.documents).toEqual(['ارفع الترخيص وكارنيه النقابة وصورتي البطاقة']);
  });

  it('locks identity fields during review, but not the bio', async () => {
    await completeOnboarding();
    await api('post', '/provider/submit-verification').expect(200);
    const locked = await api('patch', '/provider/profile').send({ license_number: 'OTHER-1' });
    expect(locked.status).toBe(409);
    expect((await api('patch', '/provider/profile').send({ bio: 'خبرة في رعاية كبار السن' })).status).toBe(
      200,
    );
    expect((await api('post', '/provider/submit-verification')).status).toBe(409);
  });
});

describe('admin decisions', () => {
  beforeEach(async () => {
    await completeOnboarding();
    await api('post', '/provider/submit-verification').expect(200);
  });

  it('request changes → provider re-uploads → resubmits', async () => {
    const id = await profileId();
    await api('post', `/admin/verifications/${id}/request-changes`, admin)
      .send({ documents: ['license'], message: 'صورة الترخيص غير واضحة' })
      .expect(200);

    const status = await api('get', '/provider/verification-status');
    expect(status.body.data).toMatchObject({
      status: 'changes_requested',
      admin_message: 'صورة الترخيص غير واضحة',
    });
    expect(status.body.data.documents.find((d: { type: string }) => d.type === 'license')).toMatchObject({
      status: 'not_matching',
      review_note: 'صورة الترخيص غير واضحة',
    });
    expect((await api('get', '/provider/profile')).body.data.onboarding.documents_uploaded).toBe(false);

    await uploadDocument('license');
    const licenses = await ProviderDocumentModel.find({ type: 'license' }).lean();
    expect(licenses.map((d) => d.status)).toEqual(['pending']); // the rejected one is gone

    expect((await api('post', '/provider/submit-verification')).body.data.status).toBe('pending');
  });

  it('reject records the reason; the provider can fix and resubmit', async () => {
    await api('post', `/admin/verifications/${await profileId()}/reject`, admin)
      .send({ reason: 'رقم النقابة غير صحيح' })
      .expect(200);
    const status = await api('get', '/provider/verification-status');
    expect(status.body.data).toMatchObject({ status: 'rejected', rejection_reason: 'رقم النقابة غير صحيح' });

    await api('patch', '/provider/profile').send({ syndicate_number: 'SYN-778' }).expect(200);
    expect((await api('post', '/provider/submit-verification')).body.data.status).toBe('pending');
  });

  it('won’t approve while a document is marked not matching, or act on non-pending profiles', async () => {
    const id = await profileId();
    const document = await ProviderDocumentModel.findOne({ type: 'national_id_front' }).lean();
    await api('post', `/admin/documents/${document!._id}/review`, admin)
      .send({ status: 'not_matching', note: 'الصورة مقصوصة' })
      .expect(200);
    const blocked = await api('post', `/admin/verifications/${id}/approve`, admin);
    expect(blocked.status).toBe(409);

    await api('post', `/admin/verifications/${id}/reject`, admin).send({ reason: 'x' }).expect(200);
    const again = await api('post', `/admin/verifications/${id}/approve`, admin);
    expect(again.status).toBe(409);
    expect(again.body.error.message).toBe('هذا الطلب ليس قيد المراجعة');
  });

  it('a document review can set the expiry date', async () => {
    const document = await ProviderDocumentModel.findOne({ type: 'license' }).lean();
    const res = await api('post', `/admin/documents/${document!._id}/review`, admin).send({
      status: 'matching',
      expires_at: '2028-06-30',
    });
    expect(res.body.data).toMatchObject({ status: 'matching', expires_at: '2028-06-30' });
  });

  it('approved documents can be replaced but not deleted', async () => {
    await api('post', `/admin/verifications/${await profileId()}/approve`, admin).expect(200);
    const document = await ProviderDocumentModel.findOne({ type: 'license' }).lean();
    const res = await api('delete', `/provider/documents/${document!._id}`);
    expect(res.status).toBe(409);
  });
});

describe('coverage and prices are validated', () => {
  it('areas: must be bookable, unique, and within the area’s travel-fee cap', async () => {
    await AreaModel.updateOne({ _id: maadi }, { maxTravelFee: 2000 });
    await invalidateCacheNamespace(LOCATIONS_CACHE);
    const res = await api('put', '/provider/service-areas').send({
      areas: [
        { area_id: nasrCity, travel_fee: 0 },
        { area_id: nasrCity, travel_fee: 0 },
        { area_id: maadi, travel_fee: 5000 },
        { area_id: '665f1c2b9e1d2a4c3b9e8f1a' },
      ],
    });
    expect(res.status).toBe(422);
    expect(res.body.error.fields).toEqual({
      'areas.1.area_id': ['مكرر'],
      'areas.2.travel_fee': ['رسوم الانتقال أعلى من الحد المسموح في هذه المنطقة'],
      'areas.3.area_id': ['الخدمة غير متاحة في هذه المنطقة حالياً'],
    });
  });

  it('services: need a provider type, an available service, and a price within the admin bounds', async () => {
    const noType = await api('put', '/provider/services').send({
      services: [{ service_id: woundDressing, price: 25000 }],
    });
    expect(noType.body.error.fields).toEqual({ type: ['اختر نوع الحساب (ممرض أو طبيب) أولاً'] });

    await api('patch', '/provider/profile').send({ type: 'nurse' }).expect(200);
    await CatalogServiceModel.updateOne({ _id: injection }, { minPrice: 10000, maxPrice: 20000 });
    await invalidateCacheNamespace(CATALOG_CACHE);
    const res = await api('put', '/provider/services').send({
      services: [
        { service_id: injection, price: 50000 },
        { service_id: '665f1c2b9e1d2a4c3b9e8f1a', price: 10000 },
      ],
    });
    expect(res.body.error.fields).toEqual({
      'services.0.price': ['السعر خارج الحدود المسموحة لهذه الخدمة'],
      'services.1.service_id': ['الخدمة غير متاحة لنوع حسابك'],
    });

    const ok = await api('put', '/provider/services').send({
      services: [{ service_id: injection, price: 15000 }],
    });
    expect(ok.body.data).toEqual([
      expect.objectContaining({ name: 'حقن عضل أو وريد', price: 15000, min_price: 10000, max_price: 20000 }),
    ]);
  });

  it('availability: no overlapping slots, end after start', async () => {
    const res = await api('put', '/provider/availability').send({
      slots: [
        { day_of_week: 1, start_time: '09:00', end_time: '13:00' },
        { day_of_week: 1, start_time: '12:00', end_time: '16:00' },
        { day_of_week: 2, start_time: '15:00', end_time: '10:00' },
      ],
    });
    expect(res.status).toBe(422);
    expect(res.body.error.fields).toEqual({
      'slots.2.end_time': ['وقت النهاية يجب أن يكون بعد وقت البداية'],
    });

    const overlap = await api('put', '/provider/availability').send({
      slots: [
        { day_of_week: 1, start_time: '09:00', end_time: '13:00' },
        { day_of_week: 1, start_time: '12:00', end_time: '16:00' },
      ],
    });
    expect(overlap.body.error.fields).toEqual({ 'slots.1': ['هذه الفترة تتداخل مع فترة أخرى في نفس اليوم'] });
  });

  it('time off: add, list, remove', async () => {
    const created = await api('post', '/provider/time-off').send({
      starts_at: '2099-10-10T00:00:00Z',
      ends_at: '2099-10-12T23:59:00Z',
      reason: 'إجازة',
    });
    expect(created.status).toBe(201);
    expect((await api('get', '/provider/time-off')).body.data).toHaveLength(1);
    await api('delete', `/provider/time-off/${created.body.data.id}`).expect(204);
    expect((await api('get', '/provider/time-off')).body.data).toEqual([]);

    const backwards = await api('post', '/provider/time-off').send({
      starts_at: '2099-10-12T00:00:00Z',
      ends_at: '2099-10-10T00:00:00Z',
    });
    expect(backwards.status).toBe(422);
  });
});

describe('access', () => {
  it('patients can’t use provider routes; providers can’t use admin routes', async () => {
    const patient = await createUserWithToken(UserRole.PATIENT);
    expect((await api('get', '/provider/profile', patient.auth)).status).toBe(403);
    expect((await api('get', '/admin/verifications')).status).toBe(403);
  });

  it('organization staff can see but not set their areas and prices', async () => {
    const staff = await createUserWithToken(UserRole.PROVIDER_STAFF);
    await ProviderProfileModel.create({ userId: staff.id });
    expect((await api('get', '/provider/profile', staff.auth)).status).toBe(200);
    expect((await api('get', '/provider/services', staff.auth)).status).toBe(200);
    expect((await api('put', '/provider/services', staff.auth).send({ services: [] })).status).toBe(403);
    expect((await api('put', '/provider/service-areas', staff.auth).send({ areas: [] })).status).toBe(403);
  });

  it('a provider can’t attach someone else’s upload', async () => {
    const other = await signUp(app, UserRole.PROVIDER);
    const upload = await request(app)
      .post('/api/v1/uploads')
      .set('Authorization', `Bearer ${other.access_token}`)
      .field('purpose', 'provider_document')
      .attach('file', sampleFiles.jpeg, 'x.jpg');
    const res = await api('post', '/provider/documents').send({
      type: 'license',
      file_key: upload.body.data.file_key,
    });
    expect(res.status).toBe(404);
  });
});
