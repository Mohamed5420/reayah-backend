import type { Express } from 'express';
import request from 'supertest';
import { UserModel } from '../../src/database/models/user/user.model';
import { Gender, ProviderType, UserRole, VerificationStatus } from '../../src/interfaces/enums';
import type { IUser } from '../../src/interfaces/IUser';
import type { IProviderProfile } from '../../src/interfaces/IProfiles';
import { ProviderProfileModel } from '../../src/database/models/provider/provider-profile.model';
import { LogSmsProvider } from '../../src/services/sms/sms.service';
import { getRedis } from '../../src/config/redis.config';
import { signTestToken } from './app';

/** A valid, unused Egyptian mobile number. */
export const randomPhone = () => `+2010${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;

/** Inserts a user directly (no OTP flow). */
export const createUser = (overrides: Partial<IUser> = {}) =>
  UserModel.create({
    phone: randomPhone(),
    fullName: 'منى حسن',
    gender: Gender.FEMALE,
    dateOfBirth: new Date('1990-05-01'),
    role: UserRole.PATIENT,
    ...overrides,
  });

/** Creates a user and returns a bearer header for them (the active-account check finds them in the DB). */
export const createUserWithToken = async (role: UserRole = UserRole.PATIENT) => {
  const user = await createUser({ role });
  const id = String(user._id);
  return { id, user, auth: `Bearer ${signTestToken({ id, role })}` };
};

/**
 * An approved, accepting provider ready to be found and booked: covers `areaIds`, offers `services`,
 * works every day 09:00–17:00 Cairo unless `availability` says otherwise.
 */
export const createBookableProvider = async (options: {
  areaIds: string[];
  services: Array<{ serviceId: string; price: number }>;
  gender?: Gender;
  travelFee?: number;
  ratingAvg?: number;
  yearsOfExperience?: number;
  availability?: Array<{ dayOfWeek: number; startTime: string; endTime: string }>;
  overrides?: Partial<IProviderProfile>;
  userOverrides?: Partial<IUser>;
}) => {
  const user = await createUser({
    role: UserRole.PROVIDER,
    gender: options.gender ?? Gender.FEMALE,
    ...options.userOverrides,
  });
  const profile = await ProviderProfileModel.create({
    userId: user._id,
    type: ProviderType.NURSE,
    yearsOfExperience: options.yearsOfExperience ?? 5,
    verificationStatus: VerificationStatus.APPROVED,
    isAcceptingBookings: true,
    ratingAvg: options.ratingAvg ?? 4.5,
    ratingCount: 10,
    serviceAreas: options.areaIds.map((areaId) => ({ areaId, travelFee: options.travelFee ?? 0 })),
    services: options.services.map((s) => ({ ...s, isActive: true })),
    availability:
      options.availability ??
      [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, startTime: '09:00', endTime: '17:00' })),
    ...options.overrides,
  });
  return { user, profile, id: String(profile._id) };
};

/** The last code the dev SMS driver "sent" to a phone. */
export const lastSmsCode = (phone: string) => {
  const message = [...LogSmsProvider.sent].reverse().find((m) => m.phone === phone);
  return message?.message.match(/\d{4}/)?.[0];
};

/** Lets a test request another code for the same phone without waiting out the 1-minute resend rule. */
export const skipOtpCooldown = (phone: string) => getRedis().del(`otp:cooldown:login:${phone}`);

/** Runs request + verify through the API and returns the verify response body's `data`. */
export const loginWithOtp = async (app: Express, phone: string) => {
  await skipOtpCooldown(phone);
  await request(app).post('/api/v1/auth/otp/request').send({ phone }).expect(200);
  const res = await request(app)
    .post('/api/v1/auth/otp/verify')
    .send({ phone, code: lastSmsCode(phone) })
    .expect(200);
  return res.body.data;
};

/** Full sign-up through the API; returns the session (`access_token`, `refresh_token`, `user`). */
export const signUp = async (
  app: Express,
  role: UserRole = UserRole.PATIENT,
  phone = randomPhone(),
  extra: Record<string, unknown> = {},
) => {
  const { registration_token } = await loginWithOtp(app, phone);
  const res = await request(app)
    .post('/api/v1/auth/register')
    .set('Authorization', `Bearer ${registration_token}`)
    .send({ role, full_name: 'أحمد محمود', gender: 'male', date_of_birth: '1985-03-12', ...extra })
    .expect(201);
  return { phone, ...res.body.data };
};
