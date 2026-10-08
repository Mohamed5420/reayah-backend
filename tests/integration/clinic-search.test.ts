import request from 'supertest';
import { Container } from 'typedi';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app';
import { useTestDatabase } from '../helpers/db';
import {
  createBookingWorld,
  type BookingWorld,
  type TestPatient,
  type TestProvider,
} from '../helpers/booking-world';
import { ServiceCategoryModel } from '../../src/database/models/catalog/service-category.model';
import { CatalogServiceModel } from '../../src/database/models/catalog/catalog-service.model';
import { ClinicModel } from '../../src/database/models/clinic/clinic.model';
import { ProviderProfileModel } from '../../src/database/models/provider/provider-profile.model';
import { ProviderTimeOffModel } from '../../src/database/models/provider/provider-time-off.model';
import { ProviderType } from '../../src/interfaces/enums';
import { BookingType } from '../../src/interfaces/IBooking';
import { ClinicStatus } from '../../src/interfaces/IClinic';
import { SettingsService } from '../../src/services/settings';
import { addDays, cairoDate, cairoToUtc } from '../../src/utils/time/cairo';

/** Clinic visits C2: search by the clinic's area, one card per clinic, profile clinics, appointment slots. */

useTestDatabase();
const app = createTestApp();

let world: BookingWorld;
let patient: TestPatient;
let consultation: string;
let doctor: TestProvider;
let clinicId: string;

const EVENINGS = Array.from({ length: 7 }, (_, d) => ({
  dayOfWeek: d,
  startTime: '18:00',
  endTime: '21:00',
}));
const tomorrow = () => addDays(cairoDate(), 1);

const get = (path: string) => request(app).get(`/api/v1${path}`).set('Authorization', patient.auth);
const enable = (on = true) =>
  Container.get(SettingsService).update({ features: { clinic_visits: on } }, { actorId: null });

/** An approved clinic for a doctor, with evening hours there every day. */
const approvedClinic = async (
  provider: TestProvider,
  overrides: Partial<{
    areaId: string;
    name: string;
    status: ClinicStatus;
    isActive: boolean;
    slotMinutes: number | null;
  }> = {},
) => {
  const clinic = await ClinicModel.create({
    providerProfileId: provider.id,
    name: overrides.name ?? 'عيادة د. منى',
    governorateId: world.cairo,
    areaId: overrides.areaId ?? world.nasrCity,
    street: 'شارع مكرم عبيد',
    building: '12',
    floor: '3',
    landmark: 'أمام سيتي ستارز',
    phone: '+20224001234',
    status: overrides.status ?? ClinicStatus.APPROVED,
    isActive: overrides.isActive ?? true,
  });
  await ProviderProfileModel.updateOne(
    { _id: provider.id },
    {
      $push: {
        clinics: {
          clinicId: clinic._id,
          slotMinutes: overrides.slotMinutes === undefined ? 20 : overrides.slotMinutes,
          instantConfirm: true,
          hours: EVENINGS,
        },
      },
    },
  );
  return String(clinic._id);
};
const newDoctor = (clinicPrice: number | null = 30000, homePrice = 50000) =>
  world.newProvider({
    services: [{ serviceId: consultation, price: homePrice }],
    overrides: {
      type: ProviderType.DOCTOR,
      specialty: 'pediatrics',
      ...(clinicPrice === null
        ? {}
        : {
            services: [
              {
                serviceId: consultation,
                price: homePrice,
                isActive: true,
                visitType: BookingType.HOME_VISIT,
              },
              {
                serviceId: consultation,
                price: clinicPrice,
                isActive: true,
                visitType: BookingType.CLINIC_VISIT,
              },
            ] as never,
          }),
    },
  });
const clinicSearch = (area = world.nasrCity, extra = '') =>
  get(`/providers?service_id=${consultation}&area_id=${area}&visit_type=clinic_visit${extra}`);

beforeEach(async () => {
  world = await createBookingWorld(app);
  patient = await world.newPatient();
  await ServiceCategoryModel.updateOne({ key: 'doctor_home_visit' }, { isActive: true });
  consultation = String((await CatalogServiceModel.findOne({ nameAr: 'كشف' }).lean())!._id);
  doctor = await newDoctor();
  clinicId = await approvedClinic(doctor);
});

describe('GET /providers?visit_type=clinic_visit', () => {
  it('is off until the clinic_visits feature is on', async () => {
    const res = await clinicSearch();
    expect(res.status).toBe(422);
    expect(res.body.error.fields).toHaveProperty('visit_type');
  });

  it("one card per doctor and clinic in the clinic's area: clinic price, no travel fee, next appointment", async () => {
    await enable();
    const res = await clinicSearch();
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      expect.objectContaining({
        kind: 'provider',
        id: doctor.id,
        visit_type: 'clinic_visit',
        clinic: { id: clinicId, name: 'عيادة د. منى', area: { id: world.nasrCity, name: 'مدينة نصر' } },
        price: 30000,
        travel_fee: 0,
        next_available: expect.any(String),
      }),
    ]);
    // The card never carries the phone or the street.
    expect(JSON.stringify(res.body.data)).not.toContain('+20224001234');

    // A second clinic in the same area is a second card; a clinic elsewhere is found by its own area.
    await approvedClinic(doctor, { name: 'فرع ثاني' });
    expect((await clinicSearch()).body.data).toHaveLength(2);
    await ProviderProfileModel.updateOne({ _id: doctor.id }, { $set: { clinics: [] } });
    const maadiDoctor = await newDoctor(28000);
    await approvedClinic(maadiDoctor, { areaId: world.maadi, name: 'عيادة المعادي' });
    expect((await clinicSearch(world.maadi)).body.data.map((c: { id: string }) => c.id)).toEqual([
      maadiDoctor.id,
    ]);

    // Home search is unchanged: home price and travel fee, no clinic.
    const home = await get(`/providers?service_id=${consultation}&area_id=${world.nasrCity}`);
    expect(home.body.data[0]).toMatchObject({ visit_type: 'home_visit', clinic: null, price: 50000 });
  });

  it('leaves out clinics not approved, paused or without hours, and doctors without a clinic price', async () => {
    await enable();
    await ClinicModel.updateMany({}, { status: ClinicStatus.PENDING });
    expect((await clinicSearch()).body.data).toEqual([]);
    await ClinicModel.updateMany({}, { status: ClinicStatus.APPROVED, isActive: false });
    expect((await clinicSearch()).body.data).toEqual([]);
    await ClinicModel.updateMany({}, { isActive: true });
    await ProviderProfileModel.updateOne({ _id: doctor.id }, { $set: { 'clinics.0.hours': [] } });
    expect((await clinicSearch()).body.data).toEqual([]);

    const homeOnly = await newDoctor(null);
    await approvedClinic(homeOnly);
    expect((await clinicSearch()).body.data).toEqual([]);
    expect((await clinicSearch(world.nasrCity, '&package_id=' + clinicId)).status).toBe(422);
  });

  it('date and time keep only doctors free then', async () => {
    await enable();
    const at = (t: string) => `&date=${tomorrow()}&time=${t}`;
    expect((await clinicSearch(world.nasrCity, at('18:20'))).body.data).toHaveLength(1);
    expect((await clinicSearch(world.nasrCity, at('18:10'))).body.data).toEqual([]); // not an appointment time
    await ProviderTimeOffModel.create({
      providerProfileId: doctor.id,
      startsAt: cairoToUtc(tomorrow(), '18:00'),
      endsAt: cairoToUtc(tomorrow(), '19:00'),
    });
    expect((await clinicSearch(world.nasrCity, at('18:20'))).body.data).toEqual([]);
    expect((await clinicSearch(world.nasrCity, at('19:00'))).body.data).toHaveLength(1);
  });
});

describe('clinic slots and profile', () => {
  it('appointments of the clinic length inside its hours, minus the doctor’s one calendar', async () => {
    await enable();
    const res = await get(
      `/providers/${doctor.id}/slots?service_id=${consultation}&date=${tomorrow()}&visit_type=clinic_visit&clinic_id=${clinicId}`,
    );
    expect(res.status).toBe(200);
    const starts = res.body.data.slots.map((s: { start: string }) => s.start);
    expect(starts).toHaveLength(9); // 18:00–21:00 in 20-minute appointments
    expect(starts[1]).toBe(cairoToUtc(tomorrow(), '18:20').toISOString());

    await ProviderTimeOffModel.create({
      providerProfileId: doctor.id,
      startsAt: cairoToUtc(tomorrow(), '18:00'),
      endsAt: cairoToUtc(tomorrow(), '18:40'),
    });
    const after = await get(
      `/providers/${doctor.id}/slots?service_id=${consultation}&date=${tomorrow()}&visit_type=clinic_visit&clinic_id=${clinicId}`,
    );
    expect(after.body.data.slots.slice(0, 3).map((s: { available: boolean }) => s.available)).toEqual([
      false,
      false,
      true,
    ]);

    // No appointment length set → the service's duration (45 minutes).
    await ProviderProfileModel.updateOne({ _id: doctor.id }, { $set: { 'clinics.0.slotMinutes': null } });
    const longer = await get(
      `/providers/${doctor.id}/slots?service_id=${consultation}&date=${tomorrow()}&visit_type=clinic_visit&clinic_id=${clinicId}`,
    );
    expect(longer.body.data.slots).toHaveLength(4);

    expect(
      (
        await get(
          `/providers/${doctor.id}/slots?service_id=${consultation}&date=${tomorrow()}&visit_type=clinic_visit`,
        )
      ).status,
    ).toBe(422);
  });

  it('the profile lists approved clinics with full text address and clinic prices, never the phone', async () => {
    const before = await get(`/providers/${doctor.id}`);
    expect(before.body.data).toMatchObject({ visit_types: ['home_visit'], clinics: [] });
    await enable();
    const res = await get(`/providers/${doctor.id}`);
    expect(res.body.data.visit_types).toEqual(['home_visit', 'clinic_visit']);
    expect(res.body.data.clinics).toEqual([
      expect.objectContaining({
        id: clinicId,
        area: { id: world.nasrCity, name: 'مدينة نصر' },
        street: 'شارع مكرم عبيد',
        landmark: 'أمام سيتي ستارز',
        appointment_minutes: 20,
        services: [expect.objectContaining({ service_id: consultation, price: 30000 })],
      }),
    ]);
    expect(JSON.stringify(res.body.data)).not.toContain('+20224001234');
    // Home services stay home prices.
    expect(res.body.data.services).toEqual([expect.objectContaining({ price: 50000 })]);
  });
});
