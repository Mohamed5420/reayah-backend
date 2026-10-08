import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, signTestToken } from '../helpers/app';
import { useTestDatabase } from '../helpers/db';
import { createUser, createUserWithToken, loginWithOtp, randomPhone, signUp } from '../helpers/fixtures';
import { ConsentDocumentModel, ConsentRecordModel } from '../../src/database/models/consent/consent.models';
import { AuditLogModel } from '../../src/database/models/audit-log/audit-log.model';
import { AdminRole, UserRole } from '../../src/interfaces/enums';

/** Launch: consent texts published as versions (wording from counsel later) and append-only records. */

useTestDatabase();
const app = createTestApp();

let admin: Awaited<ReturnType<typeof createUserWithToken>>;
beforeEach(async () => {
  admin = await createUserWithToken(UserRole.ADMIN);
});

const api = (auth?: string) => {
  const withAuth = (r: request.Test) => (auth ? r.set('Authorization', auth) : r);
  return {
    get: (path: string) => withAuth(request(app).get(`/api/v1${path}`)),
    post: (path: string, body: object) => withAuth(request(app).post(`/api/v1${path}`)).send(body),
  };
};
const publish = (kind: string, extra: Record<string, unknown> = {}) =>
  api(admin.auth).post('/admin/consent-documents', {
    kind,
    title_ar: kind === 'terms' ? 'شروط الاستخدام' : 'الموافقة على معالجة البيانات الصحية',
    body_ar: 'نص تجريبي إلى أن يرسل المستشار القانوني الصياغة النهائية.',
    ...extra,
  });

describe('consent', () => {
  it('nothing is required until a text is published', async () => {
    expect((await api().get('/consent-documents')).body.data).toEqual([]);
    const session = await signUp(app, UserRole.PATIENT);
    expect((await api(`Bearer ${session.access_token}`).get('/me/consents')).body.data).toEqual([]);
  });

  it('super admins publish versions (audited); other admin roles cannot', async () => {
    expect((await publish('terms')).body.data).toMatchObject({
      kind: 'terms',
      version: 1,
      roles: ['patient', 'provider', 'provider_staff', 'owner', 'reception'],
    });
    expect((await publish('health_data')).body.data).toMatchObject({ version: 1, roles: ['patient'] });
    expect((await publish('terms')).body.data.version).toBe(2);
    expect(await AuditLogModel.countDocuments({ action: 'consent_document.publish' })).toBe(3);

    const support = await createUser({ role: UserRole.ADMIN, adminRole: AdminRole.SUPPORT });
    const supportAuth = `Bearer ${signTestToken({ id: String(support._id), role: UserRole.ADMIN })}`;
    const asSupport = await api(supportAuth).post('/admin/consent-documents', {
      kind: 'terms',
      title_ar: 'شروط الاستخدام',
      body_ar: 'نص لا يجب أن يُنشر من دور الدعم.',
    });
    expect(asSupport.status).toBe(403);

    const forPatients = await api().get('/consent-documents?role=patient');
    expect(forPatients.body.data.map((d: { kind: string; version: number }) => [d.kind, d.version])).toEqual([
      ['terms', 2],
      ['health_data', 1],
    ]);
    const forProviders = await api().get('/consent-documents?role=provider');
    expect(forProviders.body.data.map((d: { kind: string }) => d.kind)).toEqual(['terms']);
    // Published texts are never edited.
    await expect(ConsentDocumentModel.updateOne({}, { bodyAr: 'تعديل' })).rejects.toThrow(/append-only/);
  });

  it('sign-up must accept the current texts for the role; each acceptance is recorded with time and IP', async () => {
    await publish('terms');
    await publish('health_data');
    const phone = randomPhone();
    const { registration_token } = await loginWithOtp(app, phone);
    const register = (consents?: unknown) =>
      request(app).post('/api/v1/auth/register').set('Authorization', `Bearer ${registration_token}`).send({
        role: 'patient',
        full_name: 'هدى سامي',
        gender: 'female',
        date_of_birth: '1992-02-02',
        consents,
      });

    const missing = await register([{ kind: 'terms', version: 1 }]);
    expect(missing.status).toBe(422);
    expect(missing.body.error.fields).toHaveProperty('consents');
    expect(
      (
        await register([
          { kind: 'terms', version: 1 },
          { kind: 'health_data', version: 1 },
        ])
      ).status,
    ).toBe(201);
    const records = await ConsentRecordModel.find().lean();
    expect(records.map((r) => [r.kind, r.version, r.action])).toEqual(
      expect.arrayContaining([
        ['terms', 1, 'accepted'],
        ['health_data', 1, 'accepted'],
      ]),
    );
    expect(records.every((r) => r.ip)).toBe(true);
    await expect(ConsentRecordModel.updateOne({}, { action: 'withdrawn' })).rejects.toThrow(/append-only/);

    // A provider only needs the terms.
    await signUp(app, UserRole.PROVIDER, randomPhone(), { consents: [{ kind: 'terms', version: 1 }] });
  });

  it('a new version asks again; old versions are refused; withdrawal is recorded', async () => {
    await publish('terms');
    await publish('health_data');
    const session = await signUp(app, UserRole.PATIENT, randomPhone(), {
      consents: [
        { kind: 'terms', version: 1 },
        { kind: 'health_data', version: 1 },
      ],
    });
    const me = api(`Bearer ${session.access_token}`);
    await publish('terms');
    const status = (await me.get('/me/consents')).body.data;
    expect(status).toEqual([
      expect.objectContaining({ kind: 'terms', current_version: 2, accepted_version: 1, up_to_date: false }),
      expect.objectContaining({
        kind: 'health_data',
        current_version: 1,
        accepted_version: 1,
        up_to_date: true,
      }),
    ]);

    expect(
      (await me.post('/me/consents', { consents: [{ kind: 'terms', version: 1, accepted: true }] })).status,
    ).toBe(409);
    const accepted = await me.post('/me/consents', {
      consents: [{ kind: 'terms', version: 2, accepted: true }],
    });
    expect(accepted.body.data[0]).toMatchObject({ accepted_version: 2, up_to_date: true });

    const withdrawn = await me.post('/me/consents', {
      consents: [{ kind: 'health_data', version: 1, accepted: false }],
    });
    expect(withdrawn.body.data[1]).toMatchObject({ accepted_version: null, up_to_date: false });
    expect(withdrawn.body.data[1].withdrawn_at).toEqual(expect.any(String));
  });
});
