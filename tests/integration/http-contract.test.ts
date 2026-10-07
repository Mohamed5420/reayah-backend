import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, signTestToken } from '../helpers/app';
import { useTestDatabase } from '../helpers/db';
import { createUserWithToken } from '../helpers/fixtures';
import { runSeeds } from '../../src/database/seed';
import { UserModel } from '../../src/database/models/user/user.model';
import { UserStatus } from '../../src/interfaces/enums';

useTestDatabase();
const app = createTestApp();

describe('API contract (spec §7.0)', () => {
  let auth: string;
  let userId: string;

  beforeEach(async () => {
    ({ auth, id: userId } = await createUserWithToken());
  });

  it('wraps success in { data } and echoes a request id', async () => {
    const res = await request(app).get('/api/v1/health').set('X-Request-Id', 'req-12345678');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: expect.objectContaining({ db: 'up' }) });
    expect(res.headers['x-request-id']).toBe('req-12345678');
  });

  it('generates a request id when none (or a bad one) is sent', async () => {
    const res = await request(app).get('/api/v1/health').set('X-Request-Id', 'bad id!');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns translated errors in { error: { code, message } }', async () => {
    const res = await request(app).get('/api/v1/nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: 'المسار غير موجود' } });
    expect(res.headers['content-language']).toBe('ar');
  });

  it('turns malformed JSON into 400 BAD_REQUEST', async () => {
    const res = await request(app)
      .patch('/api/v1/me')
      .set('Authorization', auth)
      .set('Content-Type', 'application/json')
      .send('{bad json');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('validates before auth: 422 with per-field messages', async () => {
    const res = await request(app).get('/api/v1/governorates/not-an-id/areas');
    expect(res.status).toBe(422);
    expect(res.body.error).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'بيانات غير صالحة',
      fields: { id: ['قيمة غير صالحة'] },
    });
  });

  it('rejects missing and expired tokens with distinct codes', async () => {
    const missing = await request(app).get('/api/v1/me');
    expect(missing.status).toBe(401);
    expect(missing.body.error.code).toBe('UNAUTHENTICATED');

    const expired = await request(app)
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${signTestToken({ id: userId }, -10)}`);
    expect(expired.status).toBe(401);
    expect(expired.body.error.code).toBe('TOKEN_EXPIRED');
  });

  it('returns ACCOUNT_SUSPENDED for suspended users, even with a valid token', async () => {
    await UserModel.updateOne({ _id: userId }, { status: UserStatus.SUSPENDED });
    const res = await request(app).get('/api/v1/me').set('Authorization', auth);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_SUSPENDED');
  });

  it('paginates with { data, meta } and enforces per_page ≤ 100', async () => {
    await runSeeds();
    const res = await request(app).get('/api/v1/areas?per_page=2');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.meta).toEqual({ page: 1, per_page: 2, total: 48, last_page: 24 });

    const tooMany = await request(app).get('/api/v1/areas?per_page=500');
    expect(tooMany.status).toBe(422);
    expect(tooMany.body.error.fields.per_page).toBeDefined();
  });
});

describe('API docs', () => {
  it('serves an OpenAPI document built from the route schemas', async () => {
    const res = await request(app).get('/docs/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.1.0');
    expect(Object.keys(res.body.paths)).toEqual(
      expect.arrayContaining(['/api/v1/health', '/api/v1/auth/otp/request', '/api/v1/me']),
    );
    expect(res.body.paths['/api/v1/me'].get.security).toEqual([{ bearerAuth: [] }]);
    expect(res.body.paths['/api/v1/auth/otp/request'].post.security).toBeUndefined();
  });
});
