import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, signTestToken } from '../helpers/app';
import { useTestDatabase } from '../helpers/db';
import { createBookableProvider, createUser, lastSmsCode, skipOtpCooldown } from '../helpers/fixtures';
import {
  createBookingWorld,
  tomorrowAt,
  type BookingWorld,
  type TestPatient,
} from '../helpers/booking-world';
import { UserModel } from '../../src/database/models/user/user.model';
import { AuditLogModel } from '../../src/database/models/audit-log/audit-log.model';
import { BookingModel } from '../../src/database/models/booking/booking.model';
import { BookingOfferModel } from '../../src/database/models/booking/booking-offer.model';
import { UserRole } from '../../src/interfaces/enums';
import { setTestAccountIsolationForTests } from '../../src/services/auth/test-accounts';

/** Launch: allowlisted test numbers sign in with a fixed code (tests/setup/env.ts: TEST_OTP_CODE 2468). */

useTestDatabase();
const app = createTestApp();

const TEST_PHONE = '+201500000001';
const FIXED = '2468';

const requestCode = async (phone: string) => {
  await skipOtpCooldown(phone);
  return request(app).post('/api/v1/auth/otp/request').send({ phone });
};
const verify = (phone: string, code: string | undefined) =>
  request(app).post('/api/v1/auth/otp/verify').send({ phone, code });

/** Signs up a test number with the fixed code; returns the session. */
const signUpTest = async (phone: string, role = UserRole.PATIENT, extra: Record<string, unknown> = {}) => {
  await requestCode(phone).then((r) => expect(r.status).toBe(200));
  const verified = await verify(phone, FIXED);
  expect(verified.body.data.is_new_user).toBe(true);
  const res = await request(app)
    .post('/api/v1/auth/register')
    .set('Authorization', `Bearer ${verified.body.data.registration_token}`)
    .send({ role, full_name: 'مراجع المتجر', gender: 'female', date_of_birth: '1990-01-01', ...extra })
    .expect(201);
  return res.body.data as { access_token: string; user: { id: string } };
};

afterEach(() => setTestAccountIsolationForTests(null));

describe('fixed sign-in code for allowlisted numbers', () => {
  it('no SMS; the fixed code signs up a flagged test account; both steps audited', async () => {
    const session = await signUpTest(TEST_PHONE);
    expect(lastSmsCode(TEST_PHONE)).toBeUndefined();
    const user = (await UserModel.findById(session.user.id).lean())!;
    expect(user.isTestAccount).toBe(true);
    const actions = (
      await AuditLogModel.find({ entityType: 'phone' }).sort({ createdAt: 1, _id: 1 }).lean()
    ).map((a) => a.action);
    expect(actions).toEqual(['auth.test_code_issued', 'auth.test_code_used']);
    // Attempts are still capped like any code.
    await requestCode(TEST_PHONE);
    for (let i = 0; i < 4; i++)
      expect((await verify(TEST_PHONE, '1111')).body.error.code).toBe('OTP_INVALID');
    expect((await verify(TEST_PHONE, '1111')).body.error.code).toBe('OTP_MAX_ATTEMPTS');
  });

  it('other numbers never accept the fixed code, and sign-ups there are real accounts', async () => {
    const phone = '+201099990000';
    await requestCode(phone);
    expect(lastSmsCode(phone)).toBeDefined();
    expect((await verify(phone, FIXED)).body.error.code).toBe('OTP_INVALID');
  });

  it('production: a real account (or an admin) on an allowlisted number gets a real SMS code', async () => {
    setTestAccountIsolationForTests(true);
    await createUser({ phone: '+201500000002', role: UserRole.PATIENT });
    await requestCode('+201500000002');
    expect(lastSmsCode('+201500000002')).toBeDefined();
    expect((await verify('+201500000002', FIXED)).body.error.code).toBe('OTP_INVALID');

    await createUser({ phone: '+201500000003', role: UserRole.ADMIN, isTestAccount: true });
    await requestCode('+201500000003');
    expect(lastSmsCode('+201500000003')).toBeDefined();

    // A new number is fine: it becomes a test account.
    const session = await signUpTest('+201500000004');
    expect((await UserModel.findById(session.user.id).lean())!.isTestAccount).toBe(true);
  });

  it('production: moving a real account to a test number needs a real SMS code', async () => {
    setTestAccountIsolationForTests(true);
    const real = await createUser({ role: UserRole.PATIENT });
    const auth = `Bearer ${signTestToken({ id: String(real._id), role: UserRole.PATIENT })}`;
    await request(app)
      .post('/api/v1/auth/phone/change/request')
      .set('Authorization', auth)
      .send({ new_phone: TEST_PHONE })
      .expect(200);
    expect(lastSmsCode(TEST_PHONE)).toBeDefined();
  });
});

describe('production: test accounts and real accounts never meet', () => {
  let world: BookingWorld;
  let realPatient: TestPatient;

  beforeEach(async () => {
    world = await createBookingWorld(app);
    realPatient = await world.newPatient();
    setTestAccountIsolationForTests(true);
  });

  const testProvider = () =>
    createBookableProvider({
      areaIds: [world.nasrCity],
      services: [{ serviceId: world.wound, price: 25000 }],
      overrides: { isTestAccount: true },
      userOverrides: { isTestAccount: true },
    });

  /** A test patient with a Nasr City address, signed up with a test number. */
  const testPatient = async (): Promise<TestPatient> => {
    const session = await signUpTest(TEST_PHONE);
    const auth = `Bearer ${session.access_token}`;
    const profiles = await request(app).get('/api/v1/patient-profiles').set('Authorization', auth);
    const address = await request(app).post('/api/v1/addresses').set('Authorization', auth).send({
      label: 'البيت',
      governorate_id: world.cairo,
      area_id: world.nasrCity,
      street: 'شارع مكرم عبيد',
      building: '3',
    });
    return {
      auth,
      userId: session.user.id,
      selfId: profiles.body.data[0].id,
      addressId: address.body.data.id,
      phone: TEST_PHONE,
    };
  };
  const search = (auth: string) =>
    request(app)
      .get(`/api/v1/providers?service_id=${world.wound}&area_id=${world.nasrCity}`)
      .set('Authorization', auth);

  it('search and booking stay within each side', async () => {
    const real = await world.newProvider();
    const fake = await testProvider();
    const tester = await testPatient();

    const realView = (await search(realPatient.auth)).body.data.map((c: { id: string }) => c.id);
    expect(realView).toEqual([real.id]);
    const testerView = (await search(tester.auth)).body.data.map((c: { id: string }) => c.id);
    expect(testerView).toEqual([fake.id]);

    expect((await world.quote(tester, real)).status).toBe(404);
    expect((await world.quote(realPatient, { ...real, id: fake.id })).status).toBe(404);
    const booked = await world.book(tester, { ...real, id: fake.id });
    expect(booked.status).toBe(201);
    expect((await BookingModel.findById(booked.body.data.id).lean())!.isTestAccount).toBe(true);
  });

  it('a test booking that times out is offered only to test providers', async () => {
    const real = await world.newProvider();
    const first = await testProvider();
    const second = await testProvider();
    const tester = await testPatient();
    const booked = await world.book(
      tester,
      { ...real, id: first.id },
      { scheduled_start: tomorrowAt('11:00') },
    );
    await world.passDeadline(booked.body.data.id);
    const offered = (await BookingOfferModel.find({ bookingId: booked.body.data.id }).lean()).map((o) =>
      String(o.providerProfileId),
    );
    expect(offered).toEqual([second.id]);
  });
});
