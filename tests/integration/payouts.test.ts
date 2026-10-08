import mongoose from 'mongoose';
import request from 'supertest';
import { Container } from 'typedi';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app';
import { useTestDatabase } from '../helpers/db';
import { createUserWithToken } from '../helpers/fixtures';
import { eventually, queuedPushes } from '../helpers/notifications';
import {
  createBookingWorld,
  tomorrowAt,
  type BookingWorld,
  type TestPatient,
  type TestProvider,
} from '../helpers/booking-world';
import { WalletBalanceModel, WalletLedgerModel } from '../../src/database/models/ledger/wallet.model';
import { PayoutModel } from '../../src/database/models/payout/payout.models';
import { AuditLogModel } from '../../src/database/models/audit-log/audit-log.model';
import { BookingModel } from '../../src/database/models/booking/booking.model';
import { UserRole } from '../../src/interfaces/enums';
import { PayoutService } from '../../src/services/payouts/payout.service';
import { csvCell } from '../../src/services/reports/report.service';

/** M2.4: provider earnings, payout methods, weekly payout batches, admin finance. */

useTestDatabase();
const app = createTestApp();

let world: BookingWorld;
let patient: TestPatient;
let provider: TestProvider;
let admin: Awaited<ReturnType<typeof createUserWithToken>>;

beforeEach(async () => {
  world = await createBookingWorld(app);
  patient = await world.newPatient();
  provider = await world.newProvider();
  admin = await createUserWithToken(UserRole.ADMIN);
});

const as = (auth: string) => ({
  get: (path: string) => request(app).get(`/api/v1${path}`).set('Authorization', auth),
  post: (path: string, body?: object) =>
    request(app).post(`/api/v1${path}`).set('Authorization', auth).send(body),
  put: (path: string, body: object) =>
    request(app).put(`/api/v1${path}`).set('Authorization', auth).send(body),
});

const bankMethod = {
  type: 'bank',
  account_holder: 'منى حسن علي',
  bank_name: 'بنك مصر',
  account_number: 'EG380019000500000000263180002',
};

/** Credits the provider through the audited admin adjustment endpoint. */
const credit = (amount: number) =>
  as(admin.auth).post('/admin/ledger/adjustment', {
    owner_type: 'provider',
    owner_id: provider.id,
    amount,
    reason: 'رصيد تجريبي',
  });

describe('payout method', () => {
  it('is stored encrypted and shown masked; bank needs a bank name', async () => {
    expect((await as(provider.auth).get('/provider/payout-method')).body.data).toBeNull();
    expect(
      (await as(provider.auth).put('/provider/payout-method', { ...bankMethod, bank_name: null })).status,
    ).toBe(422);

    const saved = await as(provider.auth).put('/provider/payout-method', bankMethod);
    expect(saved.body.data).toEqual({
      type: 'bank',
      account_holder: 'منى حسن علي',
      bank_name: 'بنك مصر',
      wallet_provider: null,
      account_number_last4: '0002',
      label: 'بنك مصر •••• 0002',
    });
    const raw = await mongoose.connection.collection('payout_methods').findOne({});
    expect(String(raw!.accountNumber)).toMatch(/^enc:v1:/);

    const wallet = await as(provider.auth).put('/provider/payout-method', {
      type: 'wallet',
      account_holder: 'منى حسن',
      wallet_provider: 'vodafone_cash',
      account_number: '01001234567',
    });
    expect(wallet.body.data).toMatchObject({ label: 'vodafone_cash •••• 4567', bank_name: null });
    expect((await as(patient.auth).get('/provider/payout-method')).status).toBe(403);
  });
});

describe('earnings', () => {
  it('sums completed visits for the period and shows what is owed each way', async () => {
    const booked = await world.book(patient, provider, { scheduled_start: tomorrowAt('10:00') });
    for (const step of ['accept', 'on-the-way', 'start', 'complete']) {
      await world.providerApi(provider, 'post', `/bookings/${booked.body.data.id}/${step}`);
    }
    const price = (await BookingModel.findById(booked.body.data.id).lean())!.price;
    const earnings = await as(provider.auth).get('/provider/earnings');
    expect(earnings.body.data).toMatchObject({
      completed_visits: 1,
      gross: price.subtotal + price.travelFee,
      commission: price.commissionAmount,
      net: price.providerPayout,
      wallet_balance: 0,
      commission_due: price.commissionAmount, // cash: the provider owes the platform
      payout_method: null,
    });

    const ledger = await as(provider.auth).get('/provider/ledger');
    expect(ledger.body.data).toEqual([
      expect.objectContaining({ type: 'commission_due', amount: -price.commissionAmount }),
    ]);

    const dues = await as(admin.auth).get('/admin/commission-dues');
    expect(dues.body.data).toEqual([
      expect.objectContaining({
        provider: expect.objectContaining({ id: provider.id }),
        amount_due: price.commissionAmount,
      }),
    ]);
  });
});

describe('payout batches', () => {
  it('generate → approve → mark paid; the balance moves out once and the provider is told', async () => {
    expect((await credit(50000)).status).toBe(201);
    expect(await AuditLogModel.exists({ action: 'ledger.adjustment', entityId: provider.id })).toBeTruthy();

    // No payout method yet: skipped.
    expect((await as(admin.auth).post('/admin/payouts/generate')).body.data).toEqual({
      created: 0,
      total: 0,
    });

    await as(provider.auth).put('/provider/payout-method', bankMethod);
    expect((await as(admin.auth).post('/admin/payouts/generate')).body.data).toEqual({
      created: 1,
      total: 50000,
    });
    expect((await WalletBalanceModel.findOne({ ownerId: provider.id }).lean())!.balance).toBe(0);
    // Nothing left to pay, and the open payout blocks a second one anyway.
    await credit(20000);
    expect((await as(admin.auth).post('/admin/payouts/generate')).body.data.created).toBe(0);

    const queue = await as(admin.auth).get('/admin/payouts?status=pending');
    expect(queue.body.data).toEqual([
      expect.objectContaining({
        amount: 50000,
        destination: 'بنك مصر •••• 0002',
        provider: expect.objectContaining({ id: provider.id }),
        destination_details: expect.objectContaining({ accountNumber: bankMethod.account_number }),
      }),
    ]);
    const payoutId: string = queue.body.data[0].id;

    // Must be approved before it can be paid.
    expect(
      (await as(admin.auth).post(`/admin/payouts/${payoutId}/mark-paid`, { reference: 'TRX-1' })).status,
    ).toBe(409);
    const approved = await as(admin.auth).post('/admin/payouts/bulk-approve', {
      payout_ids: [payoutId, '665f1c2b9e1d2a4c3b9e8f1a'],
    });
    expect(approved.body.data).toEqual({ approved: [payoutId], skipped: ['665f1c2b9e1d2a4c3b9e8f1a'] });
    const paid = await as(admin.auth).post(`/admin/payouts/${payoutId}/mark-paid`, { reference: 'TRX-1' });
    expect(paid.body.data).toMatchObject({ status: 'paid', reference: 'TRX-1' });
    await eventually(() =>
      expect(queuedPushes().some((p) => p.userId === provider.userId && p.data.type === 'payout')).toBe(true),
    );

    expect((await as(provider.auth).get('/provider/payouts')).body.data).toEqual([
      expect.objectContaining({ id: payoutId, status: 'paid', reference: 'TRX-1', amount: 50000 }),
    ]);
    const types = (await WalletLedgerModel.find({ ownerId: provider.id }).sort({ createdAt: 1 }).lean()).map(
      (e) => [e.type, e.amount],
    );
    expect(types).toEqual([
      ['adjustment', 50000],
      ['payout', -50000],
      ['adjustment', 20000],
    ]);
  });

  it('a cancelled payout puts the money back', async () => {
    await credit(30000);
    await as(provider.auth).put('/provider/payout-method', bankMethod);
    await as(admin.auth).post('/admin/payouts/generate');
    const payout = await PayoutModel.findOne({ ownerId: provider.id }).lean();

    const cancelled = await as(admin.auth).post(`/admin/payouts/${String(payout!._id)}/cancel`, {
      reason: 'رقم حساب خاطئ',
    });
    expect(cancelled.body.data.status).toBe('cancelled');
    expect((await WalletBalanceModel.findOne({ ownerId: provider.id }).lean())!.balance).toBe(30000);
    expect(
      (await as(admin.auth).post(`/admin/payouts/${String(payout!._id)}/cancel`, { reason: 'مرة تانية' }))
        .status,
    ).toBe(409);
  });

  it('the weekly job runs on payout_day only, once', async () => {
    await credit(30000);
    await as(provider.auth).put('/provider/payout-method', bankMethod);
    const payouts = Container.get(PayoutService);
    expect(await payouts.runScheduled(new Date('2026-10-14T08:00:00Z'))).toEqual({ created: 0 }); // a Wednesday
    expect(await payouts.runScheduled(new Date('2026-10-15T08:00:00Z'))).toEqual({ created: 1 }); // Thursday
    await credit(30000);
    await as(admin.auth).post('/admin/payouts/bulk-approve', {
      payout_ids: [String((await PayoutModel.findOne({}).lean())!._id)],
    });
    expect(await payouts.runScheduled(new Date('2026-10-15T09:00:00Z'))).toEqual({ created: 0 }); // same day
  });
});

describe('exports', () => {
  it('serves CSV with a header row, audited', async () => {
    await world.book(patient, provider, { scheduled_start: tomorrowAt('10:00') });
    const today = new Date().toISOString().slice(0, 10);
    const res = await as(admin.auth).get(`/admin/reports/export?type=bookings&from=2026-01-01&to=${today}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const [header, row] = res.text.replace(/^\uFEFF/, '').split('\r\n');
    expect(header).toContain('"reference_code"');
    expect(row).toContain('"pending"');
    expect(res.text).not.toContain(patient.phone);
    expect(await AuditLogModel.exists({ action: 'report.export', entityId: 'bookings' })).toBeTruthy();
    expect(
      (await as(patient.auth).get(`/admin/reports/export?type=bookings&from=2026-01-01&to=${today}`)).status,
    ).toBe(403);
  });

  it('neutralises spreadsheet formulas in cells', () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(csvCell('-5')).toBe(`"'-5"`);
    expect(csvCell(-5)).toBe('"-5"'); // a real number, not text
    expect(csvCell('غيار على جرح')).toBe('"غيار على جرح"');
  });
});
