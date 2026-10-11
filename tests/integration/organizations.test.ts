import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app';
import { useTestDatabase } from '../helpers/db';
import { createUserWithToken, signUp } from '../helpers/fixtures';
import { clearQueuedPushes, eventually, queuedPushes } from '../helpers/notifications';
import { sampleFiles, useFakeStorage } from '../helpers/storage';
import { createBookingWorld, type BookingWorld } from '../helpers/booking-world';
import { AuditLogModel } from '../../src/database/models/audit-log/audit-log.model';
import { ProviderProfileModel } from '../../src/database/models/provider/provider-profile.model';
import { UserRole } from '../../src/interfaces/enums';

/** M3.1: organization setup and verification (spec §7.11 setup, §7.15). */

useTestDatabase();
useFakeStorage();
const app = createTestApp();

let world: BookingWorld;
let owner: { auth: string; userId: string };
let admin: Awaited<ReturnType<typeof createUserWithToken>>;

const newOwner = async () => {
  const session = await signUp(app, UserRole.OWNER);
  return { auth: `Bearer ${session.access_token}`, userId: session.user.id as string };
};

beforeEach(async () => {
  world = await createBookingWorld(app);
  owner = await newOwner();
  admin = await createUserWithToken(UserRole.ADMIN);
  clearQueuedPushes();
});

const api = (auth: string) => ({
  get: (path: string) => request(app).get(`/api/v1${path}`).set('Authorization', auth),
  post: (path: string, body?: object) =>
    request(app).post(`/api/v1${path}`).set('Authorization', auth).send(body),
  put: (path: string, body: object) =>
    request(app).put(`/api/v1${path}`).set('Authorization', auth).send(body),
  patch: (path: string, body: object) =>
    request(app).patch(`/api/v1${path}`).set('Authorization', auth).send(body),
});

const orgBody = (overrides: object = {}) => ({
  name: 'مركز الشفاء للتمريض',
  type: 'nursing_center',
  commercial_register_no: '123456',
  tax_id: '987-654-321',
  phone: '+20222223333',
  address_text: '12 شارع مكرم عبيد، مدينة نصر',
  governorate_id: world.cairo,
  area_id: world.nasrCity,
  manager_name: 'أحمد سمير',
  ...overrides,
});

const upload = async (auth: string, purpose: string, file = sampleFiles.pdf, name = 'doc.pdf') => {
  const res = await request(app)
    .post('/api/v1/uploads')
    .set('Authorization', auth)
    .field('purpose', purpose)
    .attach('file', file, name);
  expect(res.status).toBe(201);
  return res.body.data.file_key as string;
};

type OrgDocumentType = 'commercial_register' | 'tax_card' | 'activity_licence' | 'manager_id';
/** The extra fields each type needs: the licence's authority and expiry, the ID card's back. */
const attach = async (type: OrgDocumentType) =>
  api(owner.auth).post('/org/documents', {
    type,
    file_key: await upload(owner.auth, 'org_document'),
    ...(type === 'activity_licence'
      ? { issuing_authority: 'ministry_of_health', expires_at: '2030-12-31' }
      : {}),
    ...(type === 'manager_id' ? { back_file_key: await upload(owner.auth, 'org_document') } : {}),
  });
const ALL_DOCUMENTS: OrgDocumentType[] = [
  'commercial_register',
  'tax_card',
  'activity_licence',
  'manager_id',
];

/** Info, all four documents, one area, one service: ready to submit. */
const setUp = async () => {
  await api(owner.auth).post('/org', orgBody()).expect(201);
  for (const type of ALL_DOCUMENTS) await attach(type);
  await api(owner.auth)
    .put('/org/service-areas', { areas: [{ area_id: world.nasrCity, travel_fee: 3000 }] })
    .expect(200);
  await api(owner.auth)
    .put('/org/services', { services: [{ service_id: world.wound, price: 30000 }] })
    .expect(200);
};

describe('organization setup', () => {
  it('create once per owner; owners only; /me shows it', async () => {
    expect((await api(owner.auth).get('/org')).status).toBe(404);
    const created = await api(owner.auth).post('/org', orgBody());
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      name: 'مركز الشفاء للتمريض',
      type: 'nursing_center',
      verification_status: 'draft',
      logo_url: null,
      governorate: { id: world.cairo, name: expect.any(String) },
      area: { id: world.nasrCity, name: 'مدينة نصر' },
      manager_name: 'أحمد سمير',
      email: null,
      paused: null,
      onboarding: {
        info_completed: true,
        documents_uploaded: false,
        areas_selected: false,
        services_set: false,
        can_submit: false,
      },
    });
    expect((await api(owner.auth).post('/org', orgBody({ commercial_register_no: '999' }))).status).toBe(409);
    // The same commercial register can't be registered twice.
    const other = await newOwner();
    expect((await api(other.auth).post('/org', orgBody())).status).toBe(409);

    const patient = await world.newPatient();
    expect((await api(patient.auth).post('/org', orgBody({ commercial_register_no: '555' }))).status).toBe(
      403,
    );
    // Coordinates are never accepted (text address only).
    expect(
      (await api(other.auth).post('/org', orgBody({ commercial_register_no: '777', lat: 30 }))).status,
    ).toBe(422);

    const me = await api(owner.auth).get('/me');
    expect(me.body.data.organization).toMatchObject({
      name: 'مركز الشفاء للتمريض',
      verification_status: 'draft',
    });
  });

  it('areas with travel fee and team size, services with prices, logo, documents', async () => {
    await api(owner.auth).post('/org', orgBody()).expect(201);

    const bad = await api(owner.auth).put('/org/service-areas', {
      areas: [
        { area_id: world.nasrCity, travel_fee: 3000 },
        { area_id: world.nasrCity, travel_fee: 1000 },
      ],
    });
    expect(bad.body.error.fields).toHaveProperty(['areas.1.area_id']);
    const areas = await api(owner.auth).put('/org/service-areas', {
      areas: [
        { area_id: world.nasrCity, travel_fee: 3000 },
        { area_id: world.maadi, travel_fee: 2000, is_active: false },
      ],
    });
    expect(areas.body.data).toEqual([
      expect.objectContaining({
        area_id: world.nasrCity,
        name: 'مدينة نصر',
        travel_fee: 3000,
        is_active: true,
        team_size: 0,
      }),
      expect.objectContaining({ area_id: world.maadi, is_active: false, team_size: 0 }),
    ]);

    // Team size = approved staff of this organization covering the area and taking bookings (M3.2 adds invites).
    const org = (await api(owner.auth).get('/org')).body.data;
    const staff = await world.newProvider();
    await ProviderProfileModel.updateOne({ _id: staff.id }, { organizationId: org.id });
    const withTeam = await api(owner.auth).get('/org/service-areas');
    expect(withTeam.body.data[0].team_size).toBe(1);

    const unknown = await api(owner.auth).put('/org/services', {
      services: [{ service_id: owner.userId, price: 30000 }],
    });
    expect(unknown.body.error.fields).toHaveProperty(['services.0.service_id']);
    const services = await api(owner.auth).put('/org/services', {
      services: [{ service_id: world.wound, price: 30000 }],
    });
    expect(services.body.data).toEqual([
      expect.objectContaining({
        service_id: world.wound,
        name: 'غيار على جرح',
        price: 30000,
        is_active: true,
      }),
    ]);

    const logo = await request(app)
      .post('/api/v1/org/logo')
      .set('Authorization', owner.auth)
      .attach('file', sampleFiles.png, 'logo.png');
    expect(logo.status).toBe(200);
    expect(logo.body.data.logo_url).toContain('org-logos/');

    expect((await attach('commercial_register')).status).toBe(201);
    expect((await attach('commercial_register')).status).toBe(201); // replaces
    const docs = await api(owner.auth).get('/org/documents');
    expect(docs.body.data.map((d: { type: string }) => d.type)).toEqual(['commercial_register']);
    // Someone else's upload can't be attached.
    const foreign = await upload((await world.newPatient()).auth, 'org_document');
    expect(
      (await api(owner.auth).post('/org/documents', { type: 'tax_card', file_key: foreign })).status,
    ).toBe(404);
  });
});

describe('verification', () => {
  it('submit → request changes → resubmit → approve, through the shared admin queue', async () => {
    await api(owner.auth).post('/org', orgBody()).expect(201);
    const early = await api(owner.auth).post('/org/submit-verification');
    expect(early.status).toBe(422);
    expect(Object.keys(early.body.error.fields).sort()).toEqual(['documents', 'service_areas', 'services']);
    expect(early.body.error.fields.documents).toEqual([
      'ارفع السجل التجاري والبطاقة الضريبية وترخيص مزاولة النشاط وبطاقة المدير',
    ]);

    await api(owner.auth).patch('/org', { name: 'مركز الشفاء' }).expect(200); // editable while draft
    for (const type of ALL_DOCUMENTS) await attach(type);
    await api(owner.auth).put('/org/service-areas', {
      areas: [{ area_id: world.nasrCity, travel_fee: 3000 }],
    });
    await api(owner.auth).put('/org/services', { services: [{ service_id: world.wound, price: 30000 }] });
    const submitted = await api(owner.auth).post('/org/submit-verification');
    expect(submitted.body.data.verification_status).toBe('pending');

    // Identity is locked while pending; the rest stays editable.
    expect((await api(owner.auth).patch('/org', { tax_id: '111-222-333' })).status).toBe(409);
    expect(
      (await api(owner.auth).patch('/org', { description: 'رعاية منزلية على مدار الساعة' })).status,
    ).toBe(200);

    const queue = await api(admin.auth).get('/admin/verifications?type=organization');
    expect(queue.body.data).toEqual([
      expect.objectContaining({
        type: 'organization',
        name: 'مركز الشفاء',
        documents_count: 4,
        status: 'pending',
      }),
    ]);
    const id: string = queue.body.data[0].id;
    // The provider queue doesn't mix them in.
    expect((await api(admin.auth).get('/admin/verifications')).body.data).toEqual([]);

    const detail = await api(admin.auth).get(`/admin/verifications/${id}`);
    expect(detail.body.data).toMatchObject({
      kind: 'organization',
      owner: { id: owner.userId },
      commission_rate: null,
      service_areas: [expect.objectContaining({ travel_fee: 3000 })],
      services: [expect.objectContaining({ price: 30000 })],
    });
    expect(detail.body.data.documents).toHaveLength(4);

    const changes = await api(admin.auth).post(`/admin/verifications/${id}/request-changes`, {
      message: 'صورة البطاقة الضريبية غير واضحة',
      documents: ['tax_card'],
    });
    expect(changes.body.data.verification_status).toBe('changes_requested');
    const taxCard = changes.body.data.documents.find((d: { type: string }) => d.type === 'tax_card');
    expect(taxCard).toMatchObject({ status: 'not_matching', review_note: 'صورة البطاقة الضريبية غير واضحة' });
    expect((await api(owner.auth).post('/org/submit-verification')).status).toBe(422); // tax card to redo
    await eventually(() =>
      expect(
        queuedPushes().some((p) => p.userId === owner.userId && p.body === 'صورة البطاقة الضريبية غير واضحة'),
      ).toBe(true),
    );

    await attach('tax_card');
    await api(owner.auth).post('/org/submit-verification').expect(200);
    const approved = await api(admin.auth).post(`/admin/verifications/${id}/approve`);
    expect(approved.body.data.verification_status).toBe('approved');
    expect(approved.body.data.documents.every((d: { status: string }) => d.status === 'matching')).toBe(true);
    expect(await AuditLogModel.exists({ action: 'organization.approve', entityId: id })).toBeTruthy();
    await eventually(() =>
      expect(queuedPushes().some((p) => p.userId === owner.userId && p.title === 'تم توثيق مؤسستك')).toBe(
        true,
      ),
    );
    expect((await api(admin.auth).post(`/admin/verifications/${id}/approve`)).status).toBe(409); // not pending
  });

  it('reject, and single-document review', async () => {
    await setUp();
    await api(owner.auth).post('/org/submit-verification').expect(200);
    const id: string = (await api(owner.auth).get('/org')).body.data.id;
    const [document] = (await api(owner.auth).get('/org/documents')).body.data;
    const reviewed = await api(admin.auth).post(`/admin/documents/${document.id}/review`, {
      status: 'matching',
      expires_at: '2030-06-30',
    });
    expect(reviewed.body.data).toMatchObject({
      id: document.id,
      status: 'matching',
      expires_at: '2030-06-30',
    });

    const rejected = await api(admin.auth).post(`/admin/verifications/${id}/reject`, {
      reason: 'السجل التجاري منتهي',
    });
    expect(rejected.body.data).toMatchObject({
      verification_status: 'rejected',
      rejection_reason: 'السجل التجاري منتهي',
    });
    // Rejected: identity can be fixed again, then resubmitted.
    await api(owner.auth).patch('/org', { commercial_register_no: '654321' }).expect(200);
    expect((await api(owner.auth).post('/org/submit-verification')).body.data.verification_status).toBe(
      'pending',
    );
  });
});

describe('admin organizations', () => {
  it('list, details, custom commission rate (audited)', async () => {
    await setUp();
    const list = await api(admin.auth).get('/admin/organizations?search=الشفاء');
    expect(list.body.data).toEqual([
      expect.objectContaining({
        name: 'مركز الشفاء للتمريض',
        verification_status: 'draft',
        owner: expect.objectContaining({ id: owner.userId }),
        service_areas_count: 1,
        services_count: 1,
      }),
    ]);
    const id: string = list.body.data[0].id;
    const updated = await api(admin.auth).patch(`/admin/organizations/${id}`, { commission_rate: 12 });
    expect(updated.body.data.commission_rate).toBe(12);
    expect(await AuditLogModel.exists({ action: 'organization.update', entityId: id })).toBeTruthy();
    expect((await api(admin.auth).patch(`/admin/organizations/${id}`, { commission_rate: 120 })).status).toBe(
      422,
    );
    expect(
      (await api(admin.auth).patch(`/admin/organizations/${id}`, { commission_rate: null })).body.data
        .commission_rate,
    ).toBeNull();
    expect((await api(owner.auth).get('/admin/organizations')).status).toBe(403);
  });
});
