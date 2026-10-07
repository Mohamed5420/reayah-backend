import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app';
import { useTestDatabase } from '../helpers/db';
import { createUserWithToken, loginWithOtp, signUp } from '../helpers/fixtures';
import { DeviceModel } from '../../src/database/models/auth/device.model';
import { UserModel } from '../../src/database/models/user/user.model';
import { AuditLogModel } from '../../src/database/models/audit-log/audit-log.model';
import { UserStatus } from '../../src/interfaces/enums';

useTestDatabase();
const app = createTestApp();

describe('PATCH /me', () => {
  it('updates account fields', async () => {
    const { auth } = await createUserWithToken();
    const res = await request(app)
      .patch('/api/v1/me')
      .set('Authorization', auth)
      .send({ full_name: 'منى علي', email: 'Mona@Example.com', date_of_birth: '1991-02-03', language: 'en' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      full_name: 'منى علي',
      email: 'mona@example.com',
      date_of_birth: '1991-02-03',
      language: 'en',
    });
  });

  it('ignores fields that can’t be changed here (role, phone, status)', async () => {
    const { auth, id, user } = await createUserWithToken();
    await request(app)
      .patch('/api/v1/me')
      .set('Authorization', auth)
      .send({ role: 'admin', phone: '+201111111111', status: 'active' })
      .expect(200);
    expect(await UserModel.findById(id).lean()).toMatchObject({ role: 'patient', phone: user.phone });
  });
});

describe('devices', () => {
  it('registers, refreshes and removes a push token', async () => {
    const { auth, id } = await createUserWithToken();
    const body = { fcm_token: 'fcm-abc', platform: 'android', app_version: '1.0.0' };
    await request(app).post('/api/v1/me/devices').set('Authorization', auth).send(body).expect(204);
    await request(app).post('/api/v1/me/devices').set('Authorization', auth).send(body).expect(204);
    expect(await DeviceModel.countDocuments({ userId: id })).toBe(1);

    await request(app).delete('/api/v1/me/devices/fcm-abc').set('Authorization', auth).expect(204);
    expect(await DeviceModel.countDocuments({ userId: id })).toBe(0);
  });

  it('moves a token to whoever logs in on that device', async () => {
    const first = await createUserWithToken();
    const second = await createUserWithToken();
    const body = { fcm_token: 'shared-device', platform: 'ios' };
    await request(app).post('/api/v1/me/devices').set('Authorization', first.auth).send(body).expect(204);
    await request(app).post('/api/v1/me/devices').set('Authorization', second.auth).send(body).expect(204);
    const device = await DeviceModel.findOne({ fcmToken: 'shared-device' }).lean();
    expect(String(device!.userId)).toBe(second.id);
  });
});

describe('DELETE /me', () => {
  it('closes the account: sessions and devices gone, phone free for a new sign-up', async () => {
    const session = await signUp(app);
    const auth = `Bearer ${session.access_token}`;
    await request(app)
      .post('/api/v1/me/devices')
      .set('Authorization', auth)
      .send({ fcm_token: 'f1', platform: 'android' });

    const res = await request(app)
      .delete('/api/v1/me')
      .set('Authorization', auth)
      .send({ reason: 'لم أعد أحتاج التطبيق' });
    expect(res.status).toBe(202);
    expect(res.body.data).toEqual({ status: 'deleted', deletion_requested_at: expect.any(String) });

    expect((await request(app).get('/api/v1/me').set('Authorization', auth)).status).toBe(401);
    expect(
      (await request(app).post('/api/v1/auth/refresh').send({ refresh_token: session.refresh_token })).status,
    ).toBe(401);
    expect(await DeviceModel.countDocuments()).toBe(0);

    const closed = await UserModel.findById(session.user.id).setOptions({ withDeleted: true }).lean();
    expect(closed).toMatchObject({ status: UserStatus.DELETED, deletedAt: expect.any(Date) });
    expect(await AuditLogModel.exists({ action: 'user.delete_request' })).toBeTruthy();

    expect((await loginWithOtp(app, session.phone)).is_new_user).toBe(true);
  });
});
