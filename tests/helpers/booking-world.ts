import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import request from 'supertest';
import { Container } from 'typedi';
import { createBookableProvider, signUp } from './fixtures';
import { signTestToken } from './app';
import { runSeeds } from '../../src/database/seed';
import { AreaModel } from '../../src/database/models/location/area.model';
import { GovernorateModel } from '../../src/database/models/location/governorate.model';
import { CatalogServiceModel } from '../../src/database/models/catalog/catalog-service.model';
import { BookingModel } from '../../src/database/models/booking/booking.model';
import { UserRole } from '../../src/interfaces/enums';
import { BookingDeadlineService } from '../../src/services/booking';
import { addDays, cairoDate, cairoToUtc } from '../../src/utils/time/cairo';

export type TestPatient = { auth: string; userId: string; selfId: string; addressId: string; phone: string };
export type TestProvider = Awaited<ReturnType<typeof createBookableProvider>> & {
  auth: string;
  userId: string;
};

/** Tomorrow at a Cairo time, as the ISO instant the API uses. */
export const tomorrowAt = (time: string) => cairoToUtc(addDays(cairoDate(), 1), time).toISOString();

/**
 * Seeds locations + catalog and returns helpers to create patients (with a Nasr City address),
 * bookable nurses (wound dressing, 250 EGP, 30 EGP travel), quotes and bookings through the real API.
 * Call it in `beforeEach` after `useTestDatabase()`.
 */
export const createBookingWorld = async (app: Express) => {
  await runSeeds();
  const cairo = String((await GovernorateModel.findOne({ nameAr: 'القاهرة' }))!._id);
  const nasrCity = String((await AreaModel.findOne({ nameAr: 'مدينة نصر' }))!._id);
  const maadi = String((await AreaModel.findOne({ nameAr: 'المعادي' }))!._id);
  const wound = String((await CatalogServiceModel.findOne({ nameAr: 'غيار على جرح' }))!._id);

  const newPatient = async (areaId = nasrCity): Promise<TestPatient> => {
    const session = await signUp(app, UserRole.PATIENT);
    const auth = `Bearer ${session.access_token}`;
    const profiles = await request(app).get('/api/v1/patient-profiles').set('Authorization', auth);
    const address = await request(app).post('/api/v1/addresses').set('Authorization', auth).send({
      label: 'البيت',
      governorate_id: cairo,
      area_id: areaId,
      street: 'شارع عباس العقاد',
      building: '15',
      floor: '4',
      apartment: '12',
    });
    return {
      auth,
      userId: session.user.id,
      selfId: profiles.body.data[0].id,
      addressId: address.body.data.id,
      phone: session.phone,
    };
  };

  const newProvider = async (
    options: Partial<Parameters<typeof createBookableProvider>[0]> = {},
  ): Promise<TestProvider> => {
    const provider = await createBookableProvider({
      areaIds: [nasrCity],
      services: [{ serviceId: wound, price: 25000 }],
      travelFee: 3000,
      ...options,
    });
    const userId = String(provider.user._id);
    return { ...provider, userId, auth: `Bearer ${signTestToken({ id: userId, role: UserRole.PROVIDER })}` };
  };

  const quote = (patient: TestPatient, provider: TestProvider, overrides: Record<string, unknown> = {}) =>
    request(app)
      .post('/api/v1/bookings/quote')
      .set('Authorization', patient.auth)
      .send({
        service_id: wound,
        provider_id: provider.id,
        patient_profile_id: patient.selfId,
        address_id: patient.addressId,
        scheduled_start: tomorrowAt('10:00'),
        ...overrides,
      });

  const book = async (
    patient: TestPatient,
    provider: TestProvider,
    overrides: Record<string, unknown> = {},
    key = randomUUID(),
  ) => {
    const q = await quote(patient, provider, overrides);
    if (q.status !== 200) return q;
    return request(app)
      .post('/api/v1/bookings')
      .set('Authorization', patient.auth)
      .set('Idempotency-Key', key)
      .send({
        quote_token: q.body.data.quote_token,
        payment_method: 'cash',
        patient_notes: 'المريض لا يستطيع الحركة',
      });
  };

  const providerApi = (provider: TestProvider, method: 'get' | 'post', path: string) =>
    request(app)[method](`/api/v1/provider${path}`).set('Authorization', provider.auth);

  /** Pretend the direct-request deadline passed, then run the 30-second sweep. */
  const passDeadline = async (bookingId: string) => {
    await BookingModel.updateOne({ _id: bookingId }, { assignmentDeadline: new Date(Date.now() - 1000) });
    await Container.get(BookingDeadlineService).processDue();
  };

  return { cairo, nasrCity, maadi, wound, newPatient, newProvider, quote, book, providerApi, passDeadline };
};

export type BookingWorld = Awaited<ReturnType<typeof createBookingWorld>>;
