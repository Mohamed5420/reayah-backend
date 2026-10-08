import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import request from 'supertest';
import { Container } from 'typedi';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app';
import { useTestDatabase } from '../helpers/db';
import { createUserWithToken, randomPhone, signUp } from '../helpers/fixtures';
import { clearQueuedPushes, eventually, queuedPushes } from '../helpers/notifications';
import { fakeBucket, useFakeStorage } from '../helpers/storage';
import {
  createBookingWorld,
  tomorrowAt,
  type BookingWorld,
  type TestPatient,
  type TestProvider,
} from '../helpers/booking-world';
import { BookingModel } from '../../src/database/models/booking/booking.model';
import { WalletLedgerModel } from '../../src/database/models/ledger/wallet.model';
import {
  OrganizationModel,
  PlanChargeModel,
  SubscriptionPlanModel,
} from '../../src/database/models/organization/organization.models';
import { withTransaction } from '../../src/database/transaction';
import { Gender, UserRole, VerificationStatus } from '../../src/interfaces/enums';
import { LedgerEntryType, LedgerOwnerType } from '../../src/interfaces/ILedger';
import { LedgerService } from '../../src/services/ledger/ledger.service';
import { SettingsService } from '../../src/services/settings';
import {
  StatementService,
  SubscriptionService,
  monthRange,
  previousMonth,
} from '../../src/services/organization';
import { setGatewayForTests } from '../../src/services/payments/gateways';
import { cairoDate } from '../../src/utils/time/cairo';
import { FakeGateway, signFakeWebhook } from '../../src/services/payments/gateways/fake.gateway';

/** M3.4: organization finance, plans, statements, dashboard, reports and packages. */

useTestDatabase();
useFakeStorage();
const app = createTestApp();

let world: BookingWorld;
let patient: TestPatient;
let owner: { auth: string; userId: string; orgId: string };
let sara: TestProvider;
let admin: Awaited<ReturnType<typeof createUserWithToken>>;

const api = (auth: string) => ({
  get: (path: string) => request(app).get(`/api/v1${path}`).set('Authorization', auth),
  post: (path: string, body?: object) =>
    request(app)
      .post(`/api/v1${path}`)
      .set('Authorization', auth)
      .set('Idempotency-Key', randomUUID())
      .send(body),
  put: (path: string, body: object) =>
    request(app).put(`/api/v1${path}`).set('Authorization', auth).send(body),
  patch: (path: string, body: object) =>
    request(app).patch(`/api/v1${path}`).set('Authorization', auth).send(body),
  delete: (path: string) => request(app).delete(`/api/v1${path}`).set('Authorization', auth),
});

const orgLedger = async () =>
  (
    await WalletLedgerModel.find({ ownerType: 'organization', ownerId: owner.orgId }).sort({ _id: 1 }).lean()
  ).map((e) => [e.type, e.amount]);

/** Books the organization (cash), assigns Sara and completes the visit. */
const completedVisit = async (at: string, overrides: Record<string, unknown> = {}) => {
  const booked = await world.book(patient, { id: '' } as TestProvider, {
    provider_id: null,
    organization_id: owner.orgId,
    scheduled_start: at,
    ...overrides,
  });
  expect(booked.status).toBe(201);
  const id: string = booked.body.data.id;
  await api(owner.auth).post(`/org/bookings/${id}/assign`, { provider_profile_id: sara.id }).expect(200);
  for (const step of ['on-the-way', 'start', 'complete']) {
    await world.providerApi(sara, 'post', `/bookings/${id}/${step}`).expect(200);
  }
  return id;
};

beforeEach(async () => {
  world = await createBookingWorld(app);
  patient = await world.newPatient();
  admin = await createUserWithToken(UserRole.ADMIN);
  const session = await signUp(app, UserRole.OWNER);
  const org = await OrganizationModel.create({
    ownerUserId: session.user.id,
    name: 'مركز الشفاء للتمريض',
    type: 'nursing_center',
    commercialRegisterNo: '123456',
    taxId: '987-654-321',
    verificationStatus: VerificationStatus.APPROVED,
    serviceAreas: [{ areaId: world.nasrCity, travelFee: 3000, isActive: true }],
    services: [{ serviceId: world.wound, price: 30000, isActive: true }],
    commissionRate: 10,
  });
  owner = { auth: `Bearer ${session.access_token}`, userId: session.user.id, orgId: String(org._id) };
  sara = await world.newProvider({
    gender: Gender.FEMALE,
    overrides: { organizationId: org._id },
    userOverrides: { role: UserRole.PROVIDER_STAFF },
  });
  setGatewayForTests(new FakeGateway());
  clearQueuedPushes();
});

describe('organization earnings and payouts', () => {
  it('visits earn for the organization; payouts, statements and admin views include organizations', async () => {
    await completedVisit(tomorrowAt('10:00'));
    expect(await orgLedger()).toEqual([['commission_due', -3000]]);
    // The staff member's own ledger stays empty.
    expect(await WalletLedgerModel.countDocuments({ ownerId: sara.id })).toBe(0);

    const earnings = await api(owner.auth).get(`/org/earnings?from=${cairoDate()}&to=${cairoDate()}`);
    expect(earnings.body.data).toMatchObject({
      completed_visits: 1,
      gross: 33000,
      commission: 3000,
      net: 30000,
      commission_due: 3000,
      payout_method: null,
    });

    await withTransaction((session) =>
      Container.get(LedgerService).record(
        {
          ownerType: LedgerOwnerType.ORGANIZATION,
          ownerId: new mongoose.Types.ObjectId(owner.orgId),
          bookingId: null,
          type: LedgerEntryType.CREDIT,
          amount: 50000,
          note: 'card visits',
        },
        session,
      ),
    );
    await api(owner.auth)
      .put('/org/payout-method', {
        type: 'bank',
        account_holder: 'مركز الشفاء',
        bank_name: 'بنك مصر',
        account_number: 'EG380019000500000000263180002',
      })
      .expect(200);
    expect((await api(admin.auth).post('/admin/payouts/generate')).body.data).toEqual({
      created: 1,
      total: 47000,
    });
    const [row] = (await api(admin.auth).get('/admin/payouts?status=pending')).body.data;
    expect(row).toMatchObject({
      owner_type: 'organization',
      provider: null,
      organization: { id: owner.orgId, name: 'مركز الشفاء للتمريض' },
      statement: { card_earnings: 50000, commission_deducted: 3000, net: 47000 },
    });
    await api(admin.auth)
      .post('/admin/payouts/bulk-approve', { payout_ids: [row.id] })
      .expect(200);
    await api(admin.auth).post(`/admin/payouts/${row.id}/mark-paid`, { reference: 'TRX-ORG' }).expect(200);
    await eventually(() =>
      expect(queuedPushes().some((p) => p.userId === owner.userId && p.data.type === 'payout')).toBe(true),
    );
    expect((await api(owner.auth).get('/org/payouts')).body.data[0]).toMatchObject({
      status: 'paid' as const,
      amount: 47000,
    });

    const adjust = await api(admin.auth).post('/admin/ledger/adjustment', {
      owner_type: 'organization',
      owner_id: owner.orgId,
      amount: -1000,
      reason: 'تسوية',
    });
    expect(adjust.status).toBe(201);
  });

  it('the organization pays what it owes from the app', async () => {
    await completedVisit(tomorrowAt('11:00'));
    const checkout = await api(owner.auth).post('/org/commission/pay', { method: 'card' });
    expect(checkout.status).toBe(201);
    const body = {
      payment_id: checkout.body.data.payment_id,
      transaction_id: 'tx-org',
      status: 'paid' as const,
      amount: 3000,
    };
    await request(app)
      .post('/api/v1/webhooks/payments/fake')
      .set('x-fake-signature', signFakeWebhook(body))
      .send(body)
      .expect(200);
    expect(await orgLedger()).toEqual([
      ['commission_due', -3000],
      ['commission_payment', 3000],
    ]);
  });
});

describe('plans', () => {
  const planId = async (key: string) =>
    (await api(owner.auth).get('/subscription-plans')).body.data.find((p: { key: string }) => p.key === key)
      .id as string;
  const credit = (amount: number) =>
    withTransaction((session) =>
      Container.get(LedgerService).record(
        {
          ownerType: LedgerOwnerType.ORGANIZATION,
          ownerId: new mongoose.Types.ObjectId(owner.orgId),
          bookingId: null,
          type: LedgerEntryType.CREDIT,
          amount,
          note: 'card visits',
        },
        session,
      ),
    );
  const unpaid = async () =>
    (await api(owner.auth).get('/org/subscription')).body.data.unpaid.amount as number;

  it('starts free; a paid plan is a charge taken from earnings when there are any; switching credits', async () => {
    const plans = await api(owner.auth).get('/subscription-plans');
    expect(plans.body.data.map((p: { key: string }) => p.key)).toEqual(['starter', 'growth']);
    expect((await api(owner.auth).get('/org/subscription')).body.data).toMatchObject({
      plan: { key: 'starter', monthly_price: 0 },
      period: null,
      usage: { staff: 1, max_staff: 5 },
      unpaid: { amount: 0, since: null },
    });

    // No earnings yet: the fee waits as a charge, off the balance.
    await api(owner.auth)
      .post('/org/subscription', { plan_id: await planId('growth') })
      .expect(200);
    expect(await unpaid()).toBe(150000);
    expect(await orgLedger()).toEqual([]);
    expect(
      (await api(owner.auth).post('/org/subscription', { plan_id: await planId('growth') })).status,
    ).toBe(409);

    // Earnings arrive: the daily run takes the fee from them.
    await credit(200000);
    await Container.get(SubscriptionService).processUnpaid();
    expect(await unpaid()).toBe(0);
    expect(await orgLedger()).toEqual([
      ['credit', 200000],
      ['subscription_fee', -150000],
    ]);

    // Renewal: 50 EGP left in earnings → partly taken, the rest still owed.
    const org = await OrganizationModel.findById(owner.orgId);
    org!.subscriptionPeriod = { start: new Date(Date.now() - 31 * 864e5), end: new Date(Date.now() - 1000) };
    await org!.save();
    expect(await Container.get(SubscriptionService).billDue()).toBe(1);
    expect(await Container.get(SubscriptionService).billDue()).toBe(0);
    expect(await unpaid()).toBe(100000);

    // Back to the free plan right away: the unused month comes off what's owed first, the rest to the balance.
    await api(owner.auth)
      .post('/org/subscription', { plan_id: await planId('starter') })
      .expect(200);
    expect(await unpaid()).toBe(0);
    const [, creditBack] = (await orgLedger()).find(([type]) => type === 'subscription_credit')!;
    expect(creditBack).toBeGreaterThan(49000);
    expect((await api(owner.auth).get('/org/subscription')).body.data.period).toBeNull();
  });

  it('plan fees never count toward the commission limit or pause bookings', async () => {
    await Container.get(SettingsService).update({ max_commission_due: 10000 }, { actorId: null });
    await api(owner.auth)
      .post('/org/subscription', { plan_id: await planId('growth') })
      .expect(200);
    expect(await unpaid()).toBe(150000);
    const limit = (await api(owner.auth).get('/org/earnings')).body.data.commission_limit;
    expect(limit).toMatchObject({ over_limit: false, warning: false });
    // A cash booking to the organization is still accepted and assignable.
    await completedVisit(tomorrowAt('13:00'));
  });

  it('unpaid: notice at 14 days, moved to the free plan at 21 days (fee still owed), staff keep working', async () => {
    await api(owner.auth)
      .post('/org/subscription', { plan_id: await planId('growth') })
      .expect(200);
    const subscriptions = Container.get(SubscriptionService);
    await PlanChargeModel.updateMany(
      { organizationId: owner.orgId },
      { chargedAt: new Date(Date.now() - 15 * 864e5) },
    );
    await subscriptions.processUnpaid();
    await subscriptions.processUnpaid();
    await eventually(() =>
      expect(
        queuedPushes().filter((p) => p.userId === owner.userId && p.title === 'رسوم الباقة لم تُسدَّد'),
      ).toHaveLength(1),
    );
    expect((await api(owner.auth).get('/org/subscription')).body.data.plan.key).toBe('growth');

    await PlanChargeModel.updateMany(
      { organizationId: owner.orgId },
      { chargedAt: new Date(Date.now() - 22 * 864e5) },
    );
    await subscriptions.processUnpaid();
    const current = (await api(owner.auth).get('/org/subscription')).body.data;
    expect(current).toMatchObject({ plan: { key: 'starter' }, period: null, unpaid: { amount: 150000 } });
    await eventually(() =>
      expect(
        queuedPushes().some((p) => p.userId === owner.userId && p.title === 'تم تحويلك للباقة الأساسية'),
      ).toBe(true),
    );
    // Normal over-limit rules on the free plan: no new invites; existing staff keep working; bookings go on.
    await SubscriptionPlanModel.updateOne({ key: 'starter' }, { maxStaff: 1 });
    expect(
      (
        await api(owner.auth).post('/org/staff/invite', {
          phone: randomPhone(),
          full_name: 'منى',
          type: 'nurse',
        })
      ).status,
    ).toBe(409);
    await completedVisit(tomorrowAt('14:00'));
  });

  it('a payout takes unpaid plan fees first; or the owner pays them in the app', async () => {
    await api(owner.auth)
      .post('/org/subscription', { plan_id: await planId('growth') })
      .expect(200);
    await credit(200000);
    await api(owner.auth)
      .put('/org/payout-method', {
        type: 'bank',
        account_holder: 'مركز الشفاء',
        bank_name: 'بنك مصر',
        account_number: 'EG380019000500000000263180002',
      })
      .expect(200);
    expect((await api(admin.auth).post('/admin/payouts/generate')).body.data).toEqual({
      created: 1,
      total: 50000,
    });
    const [payout] = (await api(owner.auth).get('/org/payouts')).body.data;
    expect(payout.statement).toMatchObject({ card_earnings: 200000, subscription_fees: 150000, net: 50000 });

    // Next month, paid in the app instead.
    const org = await OrganizationModel.findById(owner.orgId);
    org!.subscriptionPeriod = { start: new Date(Date.now() - 31 * 864e5), end: new Date(Date.now() - 1000) };
    await org!.save();
    await Container.get(SubscriptionService).billDue();
    expect(await unpaid()).toBe(150000);
    const checkout = await api(owner.auth).post('/org/subscription/pay', { method: 'card' });
    expect(checkout.status).toBe(201);
    expect(checkout.body.data.amount).toBe(150000);
    const body = {
      payment_id: checkout.body.data.payment_id,
      transaction_id: 'tx-plan',
      status: 'paid' as const,
      amount: 150000,
    };
    await request(app)
      .post('/api/v1/webhooks/payments/fake')
      .set('x-fake-signature', signFakeWebhook(body))
      .send(body)
      .expect(200);
    await request(app)
      .post('/api/v1/webhooks/payments/fake')
      .set('x-fake-signature', signFakeWebhook(body))
      .send(body)
      .expect(200);
    expect(await unpaid()).toBe(0);
    expect((await orgLedger()).filter(([type]) => type === 'subscription_fee')).toEqual([
      ['subscription_fee', -150000],
    ]);
    expect((await api(owner.auth).post('/org/subscription/pay', { method: 'card' })).status).toBe(409);
  });

  it('over max_staff: new invites refused, existing staff keep working', async () => {
    await SubscriptionPlanModel.updateOne({ key: 'starter' }, { maxStaff: 1 });
    const invite = await api(owner.auth).post('/org/staff/invite', {
      phone: randomPhone(),
      full_name: 'منى',
      type: 'nurse',
    });
    expect(invite.status).toBe(409);
    expect(invite.body.error.message).toBe(
      'وصلت إلى الحد الأقصى لفريقك في باقتك (1 أفراد). رقِّ الباقة أو أزل أحد الأفراد',
    );
    expect((await world.providerApi(sara, 'get', '/profile')).status).toBe(200);
  });

  it('admin manages plans; exactly one default', async () => {
    const created = await api(admin.auth).post('/admin/subscription-plans', {
      key: 'pro',
      name_ar: 'المحترفين',
      monthly_price: 300000,
      max_staff: 100,
      features: [{ ar: 'حتى 100 فرد', en: null }],
      is_default: true,
    });
    expect(created.status).toBe(201);
    const all = (await api(admin.auth).get('/admin/subscription-plans')).body.data;
    expect(
      all.filter((p: { is_default: boolean }) => p.is_default).map((p: { key: string }) => p.key),
    ).toEqual(['pro']);
    expect(
      (
        await api(admin.auth).patch(`/admin/subscription-plans/${created.body.data.id}`, {
          is_default: false,
        })
      ).status,
    ).toBe(422);
    expect((await api(owner.auth).get('/admin/subscription-plans')).status).toBe(403);
  });
});

describe('statements, dashboard and reports', () => {
  it('monthly statement: commission and plan fees, Arabic PDF, once per month', async () => {
    const id = await completedVisit(tomorrowAt('09:00'));
    // The middle of last month (Cairo), whatever today is.
    const lastMonth = new Date(monthRange(previousMonth()).from.getTime() + 14 * 864e5);
    await BookingModel.updateOne({ _id: id }, { completedAt: lastMonth });
    const growth = (await SubscriptionPlanModel.findOne({ key: 'growth' }).lean())!;
    await PlanChargeModel.create({
      organizationId: owner.orgId,
      planId: growth._id,
      planKey: 'growth',
      amount: 150000,
      remaining: 150000,
      periodStart: lastMonth,
      periodEnd: new Date(lastMonth.getTime() + 30 * 864e5),
      chargedAt: lastMonth,
    });
    const period = previousMonth();
    expect(await Container.get(StatementService).generate(period)).toBe(1);
    expect(await Container.get(StatementService).generate(period)).toBe(0);

    const [statement] = (await api(owner.auth).get('/org/invoices')).body.data;
    expect(statement).toMatchObject({
      period,
      kind: 'statement',
      visits: 1,
      commission: 3000,
      subscription_fees: 150000,
      total: 153000,
    });
    const pdf = await api(owner.auth).get(`/org/invoices/${statement.id}/pdf`);
    expect(pdf.body.data.url).toContain('org-statements/');
    const stored = [...fakeBucket.entries()].find(([key]) => key.startsWith('org-statements/'))!;
    expect(stored[1].body.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('dashboard KPIs and alerts; report grouped by staff', async () => {
    await completedVisit(tomorrowAt('10:00'));
    const waiting = await world.book(patient, { id: '' } as TestProvider, {
      provider_id: null,
      organization_id: owner.orgId,
      scheduled_start: tomorrowAt('14:00'),
    });
    const dashboard = await api(owner.auth).get('/org/dashboard?period=month');
    expect(dashboard.body.data.bookings.unassigned).toBe(1);
    expect(dashboard.body.data.staff).toEqual({ total: 1, active_now: 0 });
    expect(dashboard.body.data.alerts).toEqual([
      expect.objectContaining({ type: 'unassigned_booking', booking_id: waiting.body.data.id }),
    ]);

    const day = tomorrowAt('10:00').slice(0, 10);
    const report = await api(owner.auth).get(`/org/reports?from=${day}&to=${day}&group_by=staff`);
    expect(report.body.data.summary).toMatchObject({ visits: 1, revenue: 33000 });
    expect(report.body.data.rows).toEqual([
      expect.objectContaining({ key: sara.id, label: 'منى حسن', visits: 1, revenue: 33000 }),
    ]);
  });
});

describe('organization packages', () => {
  it('sold upfront; each visit earns the per-visit value minus commission; that organization only', async () => {
    await Container.get(SettingsService).update(
      { features: { video_consult: false, card_payment: true, packages: true } },
      { actorId: null },
    );
    const created = await api(owner.auth).post('/org/packages', {
      name_ar: 'باقة الغيار من المركز',
      service_id: world.wound,
      visits_count: 4,
      validity_days: 30,
      price: 100000,
    });
    expect(created.status).toBe(201);
    expect(
      (
        await api(owner.auth).post('/org/packages', {
          name_ar: 'x',
          service_id: owner.userId,
          visits_count: 1,
          validity_days: 1,
          price: 1000,
        })
      ).status,
    ).toBe(422);

    const listed = await api(patient.auth).get(`/packages?area_id=${world.nasrCity}`);
    expect(listed.body.data).toContainEqual(
      expect.objectContaining({
        id: created.body.data.id,
        organization: { id: owner.orgId, name: 'مركز الشفاء للتمريض' },
      }),
    );
    const bought = await api(patient.auth).post(`/packages/${created.body.data.id}/subscribe`, {
      patient_profile_id: patient.selfId,
      payment_method: 'card',
    });
    const paid = {
      payment_id: bought.body.data.payment_action.payment_id,
      transaction_id: 'tx-pkg',
      status: 'paid' as const,
      amount: 100000,
    };
    await request(app)
      .post('/api/v1/webhooks/payments/fake')
      .set('x-fake-signature', signFakeWebhook(paid))
      .send(paid)
      .expect(200);
    const subscriptionId: string = bought.body.data.subscription_id;

    const independent = await world.newProvider();
    const elsewhere = await world.quote(patient, independent, { package_subscription_id: subscriptionId });
    expect(elsewhere.body.error.fields.package_subscription_id).toEqual(['الباقة خاصة بمؤسسة أخرى']);

    const quote = await world.quote(patient, { id: '' } as TestProvider, {
      provider_id: null,
      organization_id: owner.orgId,
      package_subscription_id: subscriptionId,
      scheduled_start: tomorrowAt('12:00'),
    });
    expect(quote.body.data).toMatchObject({ subtotal: 25000, discounts: { package: 25000 }, total: 3000 });
    await completedVisit(tomorrowAt('12:00'), { package_subscription_id: subscriptionId });
    // Collected the 30 EGP travel fee; earns 250 − 25 (10%) + 30.
    expect(await orgLedger()).toEqual([
      ['commission_due', -2500],
      ['discount_reimbursement', 25000],
    ]);
    expect((await api(owner.auth).get('/org/packages')).body.data[0]).toMatchObject({ sold_count: 1 });
    expect((await api(owner.auth).delete(`/org/packages/${created.body.data.id}`)).status).toBe(204);
  });
});
