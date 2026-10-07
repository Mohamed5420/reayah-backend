import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app';
import { useTestDatabase } from '../helpers/db';
import {
  createUser,
  lastSmsCode,
  loginWithOtp,
  randomPhone,
  signUp,
  skipOtpCooldown,
} from '../helpers/fixtures';
import { UserModel } from '../../src/database/models/user/user.model';
import { OtpCodeModel } from '../../src/database/models/auth/otp-code.model';
import { DeviceModel } from '../../src/database/models/auth/device.model';
import { PatientProfileModel } from '../../src/database/models/patient/patient-profile.model';
import { ProviderProfileModel } from '../../src/database/models/provider/provider-profile.model';
import { AuditLogModel } from '../../src/database/models/audit-log/audit-log.model';
import { Relation, UserRole, UserStatus, VerificationStatus } from '../../src/interfaces/enums';
import { signRegistrationToken } from '../../src/services/auth';

useTestDatabase();
const app = createTestApp();

const requestOtp = (phone: string) => request(app).post('/api/v1/auth/otp/request').send({ phone });
const verifyOtp = (phone: string, code: string) =>
  request(app).post('/api/v1/auth/otp/verify').send({ phone, code });
const register = (token: string, body: Record<string, unknown>) =>
  request(app).post('/api/v1/auth/register').set('Authorization', `Bearer ${token}`).send(body);
const patientBody = { role: 'patient', full_name: 'أحمد محمود', gender: 'male', date_of_birth: '1985-03-12' };

describe('sign-up', () => {
  it('patient: OTP → registration token → account + "self" profile → working session', async () => {
    const phone = randomPhone();
    const sent = await requestOtp(phone);
    expect(sent.status).toBe(200);
    expect(sent.body.data).toEqual({ expires_in: 120, resend_after: 60 });
    expect(lastSmsCode(phone)).toMatch(/^\d{4}$/);

    const verified = await verifyOtp(phone, lastSmsCode(phone)!);
    expect(verified.body.data).toEqual({ is_new_user: true, registration_token: expect.any(String) });

    const res = await register(verified.body.data.registration_token, {
      ...patientBody,
      referral_code: 'AHMED25',
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({
      access_token: expect.any(String),
      refresh_token: expect.any(String),
      expires_in: 3600,
      user: { id: expect.any(String), full_name: 'أحمد محمود', role: 'patient', language: 'ar' },
    });

    const user = await UserModel.findById(res.body.data.user.id).lean();
    expect(user).toMatchObject({ phone, referredByCode: 'AHMED25', status: UserStatus.ACTIVE });
    expect(user!.lastLoginAt).toBeInstanceOf(Date);
    const self = await PatientProfileModel.findOne({ ownerUserId: user!._id });
    expect(self).toMatchObject({ relation: Relation.SELF, fullName: 'أحمد محمود', gender: 'male' });

    const me = await request(app)
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${res.body.data.access_token}`);
    expect(me.status).toBe(200);
    expect(me.body.data).toMatchObject({
      phone,
      role: 'patient',
      date_of_birth: '1985-03-12',
      provider_profile: null,
    });
  });

  it('provider: gets a draft provider profile shown on /me', async () => {
    const session = await signUp(app, UserRole.PROVIDER);
    const profile = await ProviderProfileModel.findOne({ userId: session.user.id }).lean();
    expect(profile).toMatchObject({
      verificationStatus: VerificationStatus.DRAFT,
      isAcceptingBookings: false,
    });
    expect(await PatientProfileModel.countDocuments()).toBe(0);

    const me = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${session.access_token}`);
    expect(me.body.data.provider_profile).toEqual({
      id: String(profile!._id),
      type: null,
      verification_status: 'draft',
      is_accepting_bookings: false,
    });
  });

  it('rejects roles that can’t self-register', async () => {
    for (const role of ['admin', 'provider_staff']) {
      const res = await register(signRegistrationToken(randomPhone()), { ...patientBody, role });
      expect(res.status).toBe(422);
      expect(res.body.error.fields.role).toBeDefined();
    }
  });

  it('rejects a registration token that is missing, forged, or reused for a taken number', async () => {
    const missing = await request(app).post('/api/v1/auth/register').send(patientBody);
    expect(missing.status).toBe(401);
    expect(missing.body.error.message).toBe('انتهت صلاحية التسجيل، برجاء طلب كود تحقق جديد');

    expect((await register('not-a-token', patientBody)).status).toBe(401);

    const token = signRegistrationToken(randomPhone());
    expect((await register(token, patientBody)).status).toBe(201);
    const again = await register(token, patientBody);
    expect(again.status).toBe(409);
    expect(again.body.error.message).toBe('رقم الموبايل مسجل بحساب آخر');
  });

  it('keeps token kinds apart: a registration token is not an access token, and vice versa', async () => {
    const regToken = signRegistrationToken(randomPhone());
    expect((await request(app).get('/api/v1/me').set('Authorization', `Bearer ${regToken}`)).status).toBe(
      401,
    );

    const session = await signUp(app);
    expect((await register(session.access_token, patientBody)).status).toBe(401);
  });

  it('validates the body: future birth date, bad email', async () => {
    const res = await register(signRegistrationToken(randomPhone()), {
      ...patientBody,
      date_of_birth: '2999-01-01',
      email: 'nope',
    });
    expect(res.status).toBe(422);
    expect(res.body.error.fields).toEqual({
      date_of_birth: ['تاريخ الميلاد غير صحيح'],
      email: ['قيمة غير صالحة'],
    });
  });
});

describe('login', () => {
  it('existing user gets a session directly', async () => {
    const user = await createUser({ role: UserRole.PROVIDER });
    const data = await loginWithOtp(app, user.phone);
    expect(data).toMatchObject({
      is_new_user: false,
      access_token: expect.any(String),
      refresh_token: expect.any(String),
      user: { id: String(user._id), role: 'provider' },
    });
    expect((await UserModel.findById(user._id).lean())!.lastLoginAt).toBeInstanceOf(Date);
  });

  it('suspended users get no session', async () => {
    const user = await createUser({ status: UserStatus.SUSPENDED });
    await requestOtp(user.phone).expect(200);
    const res = await verifyOtp(user.phone, lastSmsCode(user.phone)!);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_SUSPENDED');
  });

  it('only accepts Egyptian mobile numbers', async () => {
    for (const phone of ['01001234567', '+12025550123', '+201301234567']) {
      const res = await requestOtp(phone);
      expect(res.status).toBe(422);
      expect(res.body.error.fields.phone[0]).toContain('رقم الموبايل غير صحيح');
    }
  });
});

describe('OTP rules', () => {
  it('a code works once', async () => {
    const phone = randomPhone();
    await requestOtp(phone).expect(200);
    const code = lastSmsCode(phone)!;
    expect((await verifyOtp(phone, code)).status).toBe(200);
    expect((await verifyOtp(phone, code)).body.error.code).toBe('OTP_INVALID');
  });

  it('a new code replaces the previous one', async () => {
    const phone = randomPhone();
    await requestOtp(phone).expect(200);
    await skipOtpCooldown(phone);
    await requestOtp(phone).expect(200);

    const codes = await OtpCodeModel.find({ phone }).sort({ createdAt: 1 }).lean();
    expect(codes).toHaveLength(2);
    expect(codes[0].consumedAt).toBeInstanceOf(Date); // the first one can no longer be used
    expect(codes[1].consumedAt).toBeNull();
    expect((await verifyOtp(phone, lastSmsCode(phone)!)).status).toBe(200);
  });

  it('expired codes are refused', async () => {
    const phone = randomPhone();
    await requestOtp(phone).expect(200);
    await OtpCodeModel.updateMany({ phone }, { expiresAt: new Date(Date.now() - 1000) });
    const res = await verifyOtp(phone, lastSmsCode(phone)!);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('OTP_EXPIRED');
  });

  it('5 wrong guesses burn the code, even if the right one comes next', async () => {
    const phone = randomPhone();
    await requestOtp(phone).expect(200);
    const code = lastSmsCode(phone)!;
    const wrong = code === '0000' ? '1111' : '0000';

    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await verifyOtp(phone, wrong)).body.error.code);
    expect(codes).toEqual(['OTP_INVALID', 'OTP_INVALID', 'OTP_INVALID', 'OTP_INVALID', 'OTP_MAX_ATTEMPTS']);

    const right = await verifyOtp(phone, code);
    expect(right.status).toBe(429);
    expect(right.body.error.code).toBe('OTP_MAX_ATTEMPTS');
  });

  it('parallel guessing can’t exceed the attempt cap', async () => {
    const phone = randomPhone();
    await requestOtp(phone).expect(200);
    const wrong = lastSmsCode(phone) === '0000' ? '1111' : '0000';
    await Promise.all(Array.from({ length: 20 }, () => verifyOtp(phone, wrong)));
    const otp = await OtpCodeModel.findOne({ phone }).lean();
    expect(otp!.attempts).toBe(5);
  });

  it('the code is stored hashed, never in plain text', async () => {
    const phone = randomPhone();
    await requestOtp(phone).expect(200);
    const otp = await OtpCodeModel.findOne({ phone }).lean();
    expect(otp!.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(otp)).not.toContain(`"${lastSmsCode(phone)}"`);
  });
});

describe('OTP rate limits', () => {
  it('1 per minute per phone', async () => {
    const phone = randomPhone();
    await requestOtp(phone).expect(200);
    const res = await requestOtp(phone);
    expect(res.status).toBe(429);
    expect(res.body.error).toEqual({ code: 'RATE_LIMITED', message: 'انتظر دقيقة قبل طلب كود جديد' });
  });

  it('3 per 10 minutes per phone', async () => {
    const phone = randomPhone();
    const statuses = [];
    for (let i = 0; i < 4; i++) {
      await skipOtpCooldown(phone); // skip the 1-minute wait
      statuses.push((await requestOtp(phone)).status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
  });

  it('10 per hour per IP, across different phones', async () => {
    const statuses = [];
    for (let i = 0; i < 11; i++) statuses.push((await requestOtp(randomPhone())).status);
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

describe('sessions', () => {
  it('refresh rotates: new pair works, the old refresh token doesn’t', async () => {
    const session = await signUp(app);
    const refreshed = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refresh_token: session.refresh_token });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.data.refresh_token).not.toBe(session.refresh_token);

    const me = await request(app)
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${refreshed.body.data.access_token}`);
    expect(me.status).toBe(200);
  });

  it('reusing an old refresh token revokes the whole session (theft detection)', async () => {
    const session = await signUp(app);
    const stolen = session.refresh_token;
    const legit = await request(app).post('/api/v1/auth/refresh').send({ refresh_token: stolen });

    const replay = await request(app).post('/api/v1/auth/refresh').send({ refresh_token: stolen });
    expect(replay.status).toBe(401);
    expect(replay.body.error.message).toBe('انتهت الجلسة، برجاء تسجيل الدخول مرة أخرى');

    const next = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refresh_token: legit.body.data.refresh_token });
    expect(next.status).toBe(401);
  });

  it('other sessions of the same user are unaffected', async () => {
    const phone = randomPhone();
    const first = await signUp(app, UserRole.PATIENT, phone);
    const second = await loginWithOtp(app, phone);
    await request(app).post('/api/v1/auth/logout').send({ refresh_token: first.refresh_token }).expect(204);
    expect(
      (await request(app).post('/api/v1/auth/refresh').send({ refresh_token: second.refresh_token })).status,
    ).toBe(200);
  });

  it('logout ends the session and removes the device push token', async () => {
    const session = await signUp(app);
    const auth = `Bearer ${session.access_token}`;
    await request(app)
      .post('/api/v1/me/devices')
      .set('Authorization', auth)
      .send({ fcm_token: 'fcm-1', platform: 'android' })
      .expect(204);

    await request(app)
      .post('/api/v1/auth/logout')
      .send({ refresh_token: session.refresh_token, fcm_token: 'fcm-1' })
      .expect(204);
    expect(
      (await request(app).post('/api/v1/auth/refresh').send({ refresh_token: session.refresh_token })).status,
    ).toBe(401);
    expect(await DeviceModel.countDocuments({ fcmToken: 'fcm-1' })).toBe(0);
  });

  it('a suspended account can’t refresh', async () => {
    const session = await signUp(app);
    await UserModel.updateOne({ _id: session.user.id }, { status: UserStatus.SUSPENDED });
    const res = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refresh_token: session.refresh_token });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_SUSPENDED');
  });
});

describe('phone change', () => {
  it('verifies the new number, switches to it, and audits the change', async () => {
    const session = await signUp(app);
    const auth = `Bearer ${session.access_token}`;
    const newPhone = randomPhone();

    await request(app)
      .post('/api/v1/auth/phone/change/request')
      .set('Authorization', auth)
      .send({ new_phone: newPhone })
      .expect(200);
    const res = await request(app)
      .post('/api/v1/auth/phone/change/verify')
      .set('Authorization', auth)
      .send({ new_phone: newPhone, code: lastSmsCode(newPhone) });
    expect(res.status).toBe(200);
    expect(res.body.data.phone).toBe(newPhone);

    const audit = await AuditLogModel.findOne({ action: 'user.phone_change' }).lean();
    expect(audit!.metadata).toEqual({ from: session.phone, to: newPhone });

    // The new number now logs into the same account.
    expect((await loginWithOtp(app, newPhone)).user.id).toBe(session.user.id);
  });

  it('refuses the current number and numbers owned by someone else', async () => {
    const session = await signUp(app);
    const auth = `Bearer ${session.access_token}`;
    const other = await createUser();

    const same = await request(app)
      .post('/api/v1/auth/phone/change/request')
      .set('Authorization', auth)
      .send({ new_phone: session.phone });
    expect(same.status).toBe(422);

    const taken = await request(app)
      .post('/api/v1/auth/phone/change/request')
      .set('Authorization', auth)
      .send({ new_phone: other.phone });
    expect(taken.status).toBe(409);
  });

  it('a login code can’t be used to take over a number', async () => {
    const session = await signUp(app);
    const newPhone = randomPhone();
    await requestOtp(newPhone).expect(200); // a login code, not a phone-change code
    const res = await request(app)
      .post('/api/v1/auth/phone/change/verify')
      .set('Authorization', `Bearer ${session.access_token}`)
      .send({ new_phone: newPhone, code: lastSmsCode(newPhone) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('OTP_INVALID');
  });
});
