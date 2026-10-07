/**
 * Fills a staging database with demo data (approved nurses, patients, bookings in several states).
 *
 *   npm run seed:staging -- [--providers 200] [--patients 50] [--bookings 40]
 *
 * Needs the app's .env (MongoDB + Redis). Safe to re-run: existing demo accounts are kept.
 * Refuses to run when NODE_ENV=production.
 */
import 'reflect-metadata';
import { parseArgs } from 'node:util';
import { env } from '../config/env.config';
import { closeRedis } from '../config/redis.config';
import { connectDB, disconnectDB } from '../database';
import { seedStaging } from '../database/seed/staging';

const main = async () => {
  if (env.isProduction) {
    console.error('Refusing to seed demo data into production.');
    process.exit(1);
  }
  const { values } = parseArgs({
    options: { providers: { type: 'string' }, patients: { type: 'string' }, bookings: { type: 'string' } },
  });
  const count = (v: string | undefined) => (v === undefined ? undefined : Math.max(0, Number(v)));

  await connectDB();
  try {
    const result = await seedStaging({
      providers: count(values.providers),
      patients: count(values.patients),
      bookings: count(values.bookings),
    });
    console.log('Staging seed done:', result);
    console.log(
      'Patients: +20100000NNNN, providers: +20110000NNNN — log in with OTP (SMS_DRIVER=log prints codes).',
    );
  } finally {
    await disconnectDB();
    await closeRedis();
  }
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
