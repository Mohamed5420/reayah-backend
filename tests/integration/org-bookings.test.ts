import request from 'supertest';
import { Container } from 'typedi';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app';
import { useTestDatabase } from '../helpers/db';
import { signUp } from '../helpers/fixtures';
import { clearQueuedPushes, eventually, queuedPushes } from '../helpers/notifications';
import {
  createBookingWorld,
  tomorrowAt,
  type BookingWorld,
  type TestPatient,
  type TestProvider,
} from '../helpers/booking-world';
import { BookingModel } from '../../src/database/models/booking/booking.model';
import { BookingOfferModel } from '../../src/database/models/booking/booking-offer.model';
import { WalletLedgerModel } from '../../src/database/models/ledger/wallet.model';
import { OrganizationModel } from '../../src/database/models/organization/organization.models';
import { Gender, UserRole, VerificationStatus } from '../../src/interfaces/enums';
import { BookingDeadlineService } from '../../src/services/booking';
import { registerBookingNotifications } from '../../src/services/notification/booking-notifications';

/** M3.3: booking an organization, the owner's queue, assignment, broadcast, deadline and fallback. */

useTestDatabase();
const app = createTestApp();
registerBookingNotifications();

type Owner = { auth: string; userId: string; orgId: string };

let world: BookingWorld;
let patient: TestPatient;
let owner: Owner;
let sara: TestProvider; // staff, female, 4.8
let omar: TestProvider; // staff, male, 4.2

const api = (auth: string) => ({
  get: (path: string) => request(app).get(`/api/v1${path}`).set('Authorization', auth),
  post: (path: string, body?: object) =>
    request(app).post(`/api/v1${path}`).set('Authorization', auth).send(body),
  delete: (path: string) => request(app).delete(`/api/v1${path}`).set('Authorization', auth),
});

/** An owner with an approved organization in Nasr City (30 EGP travel), wound dressing at 300 EGP, 10% commission. */
const newOrg = async (name = 'مركز الشفاء للتمريض'): Promise<Owner> => {
  const session = await signUp(app, UserRole.OWNER);
  const org = await OrganizationModel.create({
    ownerUserId: session.user.id,
    name,
    type: 'nursing_center',
    commercialRegisterNo: String(Math.random()).slice(2, 10),
    taxId: '987-654-321',
    verificationStatus: VerificationStatus.APPROVED,
    serviceAreas: [{ areaId: world.nasrCity, travelFee: 3000, isActive: true }],
    services: [{ serviceId: world.wound, price: 30000, isActive: true }],
    commissionRate: 10,
  });
  return { auth: `Bearer ${session.access_token}`, userId: session.user.id, orgId: String(org._id) };
};

const newStaff = (orgId: string, gender: Gender, ratingAvg: number) =>
  world.newProvider({
    gender,
    ratingAvg,
    overrides: { organizationId: orgId as never },
    userOverrides: { role: UserRole.PROVIDER_STAFF },
  });

/** Books the organization (cash) for the patient. */
const bookOrg = (overrides: Record<string, unknown> = {}, orgId = owner.orgId) =>
  world.book(patient, { id: '' } as TestProvider, {
    provider_id: null,
    organization_id: orgId,
    ...overrides,
  });

const steps = async (who: TestProvider, id: string, list: string[]) => {
  for (const step of list) await world.providerApi(who, 'post', `/bookings/${id}/${step}`).expect(200);
};

beforeEach(async () => {
  world = await createBookingWorld(app);
  patient = await world.newPatient();
  owner = await newOrg();
  sara = await newStaff(owner.orgId, Gender.FEMALE, 4.8);
  omar = await newStaff(owner.orgId, Gender.MALE, 4.2);
  clearQueuedPushes();
});

describe('patients find and book organizations', () => {
  it('one card per organization; its staff never appear as independents', async () => {
    const independent = await world.newProvider();
    const search = await api(patient.auth).get(
      `/providers?service_id=${world.wound}&area_id=${world.nasrCity}`,
    );
    const cards = search.body.data as Array<{ kind: string; id: string }>;
    expect(cards.map((c) => c.id).sort()).toEqual([independent.id, owner.orgId].sort());
    expect(cards.find((c) => c.kind === 'organization')).toMatchObject({
      id: owner.orgId,
      name: 'مركز الشفاء للتمريض',
      organization: { id: owner.orgId, name: 'مركز الشفاء للتمريض' },
      price: 30000,
      travel_fee: 3000,
      team_size: 2,
      rating_avg: 4.5,
    });
    const orgsOnly = await api(patient.auth).get(
      `/providers?service_id=${world.wound}&area_id=${world.nasrCity}&source=organization&gender=male`,
    );
    expect(orgsOnly.body.data).toEqual([expect.objectContaining({ id: owner.orgId, team_size: 1 })]);
    const independents = await api(patient.auth).get(
      `/providers?service_id=${world.wound}&area_id=${world.nasrCity}&source=independent`,
    );
    expect(independents.body.data.map((c: { id: string }) => c.id)).toEqual([independent.id]);

    const page = await api(patient.auth).get(`/providers/${owner.orgId}`);
    expect(page.body.data).toMatchObject({
      kind: 'organization',
      team_size: 2,
      services: [expect.objectContaining({ price: 30000 })],
    });
    const slots = await api(patient.auth).get(
      `/providers/${owner.orgId}/slots?service_id=${world.wound}&date=${tomorrowAt('10:00').slice(0, 10)}&area_id=${world.nasrCity}`,
    );
    expect(slots.body.data.slots.some((s: { available: boolean }) => s.available)).toBe(true);
  });

  it('quote and book an organization: its price and commission rate, then the owner’s queue', async () => {
    const both = await world.quote(patient, sara, { organization_id: owner.orgId });
    expect(both.status).toBe(422);
    const quote = await world.quote(patient, { id: '' } as TestProvider, {
      provider_id: null,
      organization_id: owner.orgId,
    });
    expect(quote.body.data).toMatchObject({ subtotal: 30000, travel_fee: 3000, total: 33000 });

    const booked = await bookOrg();
    expect(booked.status).toBe(201);
    const id: string = booked.body.data.id;
    const stored = (await BookingModel.findById(id).lean())!;
    expect(stored).toMatchObject({
      assignmentMode: 'organization',
      providerProfileId: null,
      status: 'pending',
    });
    expect(stored.price).toMatchObject({ commissionRate: 10, commissionAmount: 3000, providerPayout: 30000 });
    await eventually(() =>
      expect(queuedPushes().some((p) => p.userId === owner.userId && p.title === 'طلب حجز جديد')).toBe(true),
    );
    // Staff don't see it until assigned.
    expect((await world.providerApi(sara, 'get', '/bookings')).body.data).toEqual([]);

    const patientView = await api(patient.auth).get(`/bookings/${id}`);
    expect(patientView.body.data).toMatchObject({
      organization: { id: owner.orgId, name: 'مركز الشفاء للتمريض' },
      provider: null,
    });
    const queue = await api(owner.auth).get('/org/bookings?status=pending');
    expect(queue.body.data).toEqual([
      expect.objectContaining({
        id,
        patient: null,
        address: { area_name: 'مدينة نصر', full_text: null },
        allowed_actions: ['assign', 'broadcast', 'decline'],
        price: expect.objectContaining({ payout: 30000 }),
      }),
    ]);
  });
});

describe('the owner assigns', () => {
  it('eligible staff, assign (accepted at once), ops-only details, earnings go to the organization', async () => {
    const id: string = (await bookOrg({ preferred_gender: 'female', scheduled_start: tomorrowAt('11:00') }))
      .body.data.id;
    const eligible = await api(owner.auth).get(`/org/bookings/${id}/eligible-staff`);
    expect(eligible.body.data).toEqual([
      expect.objectContaining({ id: sara.id, available: true, reason: null }),
      expect.objectContaining({ id: omar.id, available: false, reason: 'gender' }),
    ]);
    const wrong = await api(owner.auth).post(`/org/bookings/${id}/assign`, { provider_profile_id: omar.id });
    expect(wrong.status).toBe(409);
    expect(wrong.body.error.code).toBe('SLOT_UNAVAILABLE');

    const assigned = await api(owner.auth).post(`/org/bookings/${id}/assign`, {
      provider_profile_id: sara.id,
    });
    expect(assigned.status).toBe(200);
    expect(assigned.body.data).toMatchObject({
      status: 'accepted',
      staff: { id: sara.id },
      patient: { name: 'أحمد محمود', phone: patient.phone },
      address: { area_name: 'مدينة نصر', full_text: expect.stringContaining('عباس العقاد') },
    });
    expect(assigned.body.data).not.toHaveProperty('patient_notes');
    expect(assigned.body.data).not.toHaveProperty('medical');
    await eventually(() =>
      expect(queuedPushes().some((p) => p.userId === sara.userId && p.title === 'تم تعيينك لزيارة')).toBe(
        true,
      ),
    );
    expect((await api(patient.auth).get(`/bookings/${id}`)).body.data.provider).toMatchObject({
      id: sara.id,
    });

    await steps(sara, id, ['on-the-way', 'start', 'complete']);
    const ledger = await WalletLedgerModel.find({ bookingId: id }).lean();
    expect(ledger.map((e) => [e.ownerType, String(e.ownerId), e.type, e.amount])).toEqual([
      ['organization', owner.orgId, 'commission_due', -3000],
    ]);
  });

  it('send to all suitable: first staff member to accept wins', async () => {
    const id: string = (await bookOrg({ scheduled_start: tomorrowAt('12:00') })).body.data.id;
    expect((await api(owner.auth).post(`/org/bookings/${id}/broadcast`)).body.data).toEqual({ offered: 2 });
    const omarOffer = (await world.providerApi(omar, 'get', '/offers')).body.data[0];
    const saraOffer = (await world.providerApi(sara, 'get', '/offers')).body.data[0];
    expect((await world.providerApi(omar, 'post', `/offers/${omarOffer.id}/accept`)).status).toBe(200);
    const late = await world.providerApi(sara, 'post', `/offers/${saraOffer.id}/accept`);
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('OFFER_TAKEN');
    const stored = (await BookingModel.findById(id).lean())!;
    expect(String(stored.providerProfileId)).toBe(omar.id);
    expect(String(stored.organizationId)).toBe(owner.orgId);
  });

  it('reassign, cancel, and another organization can’t touch it', async () => {
    const id: string = (await bookOrg({ scheduled_start: tomorrowAt('13:00') })).body.data.id;
    await api(owner.auth).post(`/org/bookings/${id}/assign`, { provider_profile_id: sara.id }).expect(200);
    const other = await newOrg('مركز النور');
    expect((await api(other.auth).get(`/org/bookings/${id}`)).status).toBe(404);
    expect(
      (await api(other.auth).post(`/org/bookings/${id}/assign`, { provider_profile_id: sara.id })).status,
    ).toBe(404);

    expect(
      (await api(owner.auth).post(`/org/bookings/${id}/reassign`, { provider_profile_id: omar.id })).status,
    ).toBe(422); // the reason is required
    const moved = await api(owner.auth).post(`/org/bookings/${id}/reassign`, {
      provider_profile_id: omar.id,
      reason_code: 'staff_unavailable',
      reason_text: 'سارة في إجازة مرضية',
    });
    expect(moved.body.data.staff).toMatchObject({ id: omar.id });
    expect((await world.providerApi(sara, 'get', `/bookings/${id}`)).status).toBe(404);
    await eventually(() =>
      expect(
        queuedPushes().some((p) => p.userId === sara.userId && p.title === 'تم تغيير المكلّف بالزيارة'),
      ).toBe(true),
    );

    const cancelled = await api(owner.auth).post(`/org/bookings/${id}/cancel`, {
      reason_code: 'staff_unavailable',
    });
    expect(cancelled.body.data.status).toBe('cancelled');
    await eventually(() =>
      expect(queuedPushes().some((p) => p.userId === patient.userId && p.data.status === 'cancelled')).toBe(
        true,
      ),
    );
  });

  it('removing a staff member hands their bookings back to the queue and cuts their access', async () => {
    const id: string = (await bookOrg({ scheduled_start: tomorrowAt('14:00') })).body.data.id;
    await api(owner.auth).post(`/org/bookings/${id}/assign`, { provider_profile_id: sara.id }).expect(200);
    await world.providerApi(sara, 'post', `/bookings/${id}/on-the-way`).expect(200);
    await api(patient.auth).post(`/bookings/${id}/messages`, { body: 'الجرس لا يعمل' }).expect(201);

    expect((await api(owner.auth).delete(`/org/staff/${sara.id}`)).status).toBe(204);
    const stored = (await BookingModel.findById(id).lean())!;
    expect(stored).toMatchObject({
      status: 'pending',
      providerProfileId: null,
      assignmentMode: 'organization',
    });
    expect(stored.assignmentDeadline!.getTime()).toBeGreaterThan(Date.now());
    expect((await world.providerApi(sara, 'get', `/bookings/${id}`)).status).toBe(404);
    expect((await api(sara.auth).get(`/bookings/${id}/messages`)).status).toBe(404);
    await eventually(() =>
      expect(queuedPushes().some((p) => p.userId === owner.userId && p.title === 'حجز يحتاج تعيين')).toBe(
        true,
      ),
    );
    // The owner reassigns it.
    await api(owner.auth).post(`/org/bookings/${id}/assign`, { provider_profile_id: omar.id }).expect(200);
  });

  it('reschedule: the assigned staff member keeps it when still free; staff and owner are told', async () => {
    const id: string = (await bookOrg({ scheduled_start: tomorrowAt('09:00') })).body.data.id;
    await api(owner.auth).post(`/org/bookings/${id}/assign`, { provider_profile_id: sara.id }).expect(200);
    clearQueuedPushes();
    const moved = await api(patient.auth).post(`/bookings/${id}/reschedule`, {
      scheduled_start: tomorrowAt('15:00'),
    });
    expect(moved.status).toBe(200);
    const stored = (await BookingModel.findById(id).lean())!;
    expect(stored).toMatchObject({ status: 'accepted' });
    expect(String(stored.providerProfileId)).toBe(sara.id);
    expect(stored.scheduledStart.toISOString()).toBe(tomorrowAt('15:00'));
    await eventually(() => {
      expect(queuedPushes().some((p) => p.userId === sara.userId && p.title === 'تغيّر موعد زيارة')).toBe(
        true,
      );
      expect(queuedPushes().some((p) => p.userId === owner.userId && p.title === 'تغيّر موعد حجز')).toBe(
        true,
      );
    });
  });

  it('reschedule: back to the owner’s queue when the staff member isn’t free then', async () => {
    const id: string = (await bookOrg({ scheduled_start: tomorrowAt('09:00') })).body.data.id;
    await api(owner.auth).post(`/org/bookings/${id}/assign`, { provider_profile_id: sara.id }).expect(200);
    // Sara is busy at 15:00 with another booking; Omar is free, so the organization still has the slot.
    const other: string = (await bookOrg({ scheduled_start: tomorrowAt('15:00') })).body.data.id;
    await api(owner.auth).post(`/org/bookings/${other}/assign`, { provider_profile_id: sara.id }).expect(200);
    clearQueuedPushes();
    const moved = await api(patient.auth).post(`/bookings/${id}/reschedule`, {
      scheduled_start: tomorrowAt('15:00'),
    });
    expect(moved.status).toBe(200);
    const stored = (await BookingModel.findById(id).lean())!;
    expect(stored).toMatchObject({
      status: 'pending',
      providerProfileId: null,
      assignmentMode: 'organization',
    });
    expect(stored.assignmentDeadline!.getTime()).toBeGreaterThan(Date.now());
    await eventually(() =>
      expect(queuedPushes().some((p) => p.userId === owner.userId && p.title === 'تم تغيير موعد حجز')).toBe(
        true,
      ),
    );
  });
});

describe('deadline and fallback', () => {
  it('warns the owner 10 minutes before; after the deadline it goes to independents and other organizations', async () => {
    const id: string = (await bookOrg({ scheduled_start: tomorrowAt('10:00') })).body.data.id;
    const deadlines = Container.get(BookingDeadlineService);
    await BookingModel.updateOne({ _id: id }, { assignmentDeadline: new Date(Date.now() + 5 * 60_000) });
    await deadlines.processDue();
    await deadlines.processDue();
    await eventually(() =>
      expect(
        queuedPushes().filter((p) => p.userId === owner.userId && p.title === 'متبقي 10 دقائق للتعيين'),
      ).toHaveLength(1),
    );

    const independent = await world.newProvider();
    const rival = await newOrg('مركز النور');
    const rivalStaff = await newStaff(rival.orgId, Gender.FEMALE, 4.6);
    await world.passDeadline(id);
    const stored = (await BookingModel.findById(id).lean())!;
    expect(stored).toMatchObject({ assignmentMode: 'broadcast', providerProfileId: null });
    const offers = await BookingOfferModel.find({ bookingId: id, status: 'offered' }).lean();
    expect(
      offers
        .map((o) => (o.providerProfileId ? String(o.providerProfileId) : `org:${String(o.organizationId)}`))
        .sort(),
    ).toEqual([independent.id, `org:${rival.orgId}`].sort());
    // The original organization still sees it, but can no longer assign.
    const late = await api(owner.auth).post(`/org/bookings/${id}/assign`, { provider_profile_id: sara.id });
    expect(late.body.error.code).toBe('ASSIGNMENT_DEADLINE_PASSED');
    await eventually(() =>
      expect(queuedPushes().some((p) => p.userId === rival.userId && p.title === 'طلب متاح لمؤسستك')).toBe(
        true,
      ),
    );

    // The rival organization takes it by assigning its staff member; the independent's offer is lost.
    expect((await api(rival.auth).get('/org/offers')).body.data).toEqual([
      expect.objectContaining({ id, offer: expect.any(Object) }),
    ]);
    const taken = await api(rival.auth).post(`/org/bookings/${id}/assign`, {
      provider_profile_id: rivalStaff.id,
    });
    expect(taken.status).toBe(200);
    const final = (await BookingModel.findById(id).lean())!;
    expect(String(final.organizationId)).toBe(rival.orgId);
    expect(String(final.providerProfileId)).toBe(rivalStaff.id);
    expect((await world.providerApi(independent, 'get', '/offers')).body.data).toEqual([]);
    expect((await api(owner.auth).get(`/org/bookings/${id}`)).status).toBe(404); // no longer theirs
  });

  it('declining: straight to fallback when allowed, otherwise declined', async () => {
    const noFallback: string = (
      await bookOrg({ allow_fallback: false, scheduled_start: tomorrowAt('11:00') })
    ).body.data.id;
    const declined = await api(owner.auth).post(`/org/bookings/${noFallback}/decline`, {
      reason_code: 'no_staff_available',
    });
    expect(declined.body.data).toEqual({ status: 'declined', passed_on: false });

    await world.newProvider();
    const withFallback: string = (await bookOrg({ scheduled_start: tomorrowAt('12:00') })).body.data.id;
    const passed = await api(owner.auth).post(`/org/bookings/${withFallback}/decline`, {
      reason_code: 'other',
    });
    expect(passed.body.data).toEqual({ status: 'pending', passed_on: true });
    expect((await BookingModel.findById(withFallback).lean())!.assignmentMode).toBe('broadcast');
  });
});
