import { Types } from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app';
import { useTestDatabase } from '../helpers/db';
import {
  createBookingWorld,
  type BookingWorld,
  type TestPatient,
  type TestProvider,
} from '../helpers/booking-world';
import { BookingModel } from '../../src/database/models/booking/booking.model';
import { PayoutModel } from '../../src/database/models/payout/payout.models';
import { WalletBalanceModel } from '../../src/database/models/ledger/wallet.model';
import { addDays, cairoDate, cairoToUtc } from '../../src/utils/time/cairo';

/** Provider app (M21): the earnings chart by Cairo day, cash taken, and the next weekly payout. */

useTestDatabase();
const app = createTestApp();

let world: BookingWorld;
let patient: TestPatient;
let provider: TestProvider;

beforeEach(async () => {
  world = await createBookingWorld(app);
  patient = await world.newPatient();
  provider = await world.newProvider();
});

describe('earnings', () => {
  it('one row per Cairo day with zeros, and the cash taken from patients', async () => {
    const today = cairoDate();
    const from = addDays(today, -6);
    const id = (await world.book(patient, provider)).body.data.id;
    await BookingModel.updateOne(
      { _id: id },
      { status: 'completed', completedAt: cairoToUtc(addDays(today, -2), '12:00'), paymentMethod: 'cash' },
    );
    const done = (await BookingModel.findById(id).lean())!;
    const res = await request(app)
      .get(`/api/v1/provider/earnings?from=${from}&to=${today}`)
      .set('Authorization', provider.auth);
    expect(res.body.data.days).toHaveLength(7);
    expect(res.body.data.days[0]).toEqual({ date: from, completed_visits: 0, net: 0 });
    expect(res.body.data.days[4]).toEqual({
      date: addDays(today, -2),
      completed_visits: 1,
      net: done.price.providerPayout,
    });
    expect(res.body.data.cash_collected).toBe(done.price.total);

    const reversed = await request(app)
      .get(`/api/v1/provider/earnings?from=${today}&to=${from}`)
      .set('Authorization', provider.auth);
    expect(reversed.status).toBe(422);
  });

  it('next payout: the date, the amount, and a reason code when it will not be paid', async () => {
    const next = async () =>
      (await request(app).get('/api/v1/provider/earnings').set('Authorization', provider.auth)).body.data
        .next_payout;
    const first = await next();
    expect(first).toMatchObject({ amount: 0, eligible: false, reason: 'no_payout_method' });
    expect(first.date >= cairoDate()).toBe(true);

    await request(app)
      .put('/api/v1/provider/payout-method')
      .set('Authorization', provider.auth)
      .send({
        type: 'wallet',
        account_holder: 'منى حسن',
        wallet_provider: 'vodafone_cash',
        account_number: '01012345678',
      })
      .expect(200);
    const owner = { ownerType: 'provider', ownerId: new Types.ObjectId(provider.id) };
    await WalletBalanceModel.updateOne(owner, { balance: 5000 }, { upsert: true });
    expect(await next()).toMatchObject({ amount: 5000, minimum_amount: 10000, reason: 'below_minimum' });
    await WalletBalanceModel.updateOne(owner, { balance: -2000 });
    expect(await next()).toMatchObject({ amount: 0, reason: 'commission_due' });
    await WalletBalanceModel.updateOne(owner, { balance: 20000 });
    expect(await next()).toMatchObject({ amount: 20000, eligible: true, reason: null });
    await PayoutModel.collection.insertOne({
      ...owner,
      amount: 1000,
      status: 'pending',
      createdAt: new Date(),
    });
    expect((await next()).reason).toBe('payout_in_progress');
  });
});
