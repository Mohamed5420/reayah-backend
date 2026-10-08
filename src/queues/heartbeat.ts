import { getRedis } from '../config/redis.config';
import { MaintenanceJob } from './queue-names';

/**
 * Maintenance jobs record when they last finished, so monitoring can alert when one stops running —
 * otherwise booking deadlines, reminders and suspension lifts would silently stop while the API looks
 * healthy. `GET /health/jobs` answers 503 when any job has been silent longer than allowed here
 * (a few missed runs, not one).
 */
export const MAX_SILENCE_SECONDS: Record<MaintenanceJob, number> = {
  [MaintenanceJob.BOOKING_DEADLINES]: 3 * 60, // runs every 30 s
  [MaintenanceJob.BOOKING_REMINDERS]: 5 * 60, // every minute
  [MaintenanceJob.SUSPENSION_EXPIRY]: 20 * 60, // every 5 min
  [MaintenanceJob.PAYMENT_EXPIRY]: 5 * 60, // every minute
  [MaintenanceJob.PAYOUT_BATCH]: 26 * 3600, // daily
  [MaintenanceJob.PRESENCE_CLEANUP]: 3 * 3600, // hourly
  [MaintenanceJob.DOCUMENT_EXPIRY]: 26 * 3600, // daily
  [MaintenanceJob.PACKAGE_EXPIRY]: 3 * 3600, // hourly
  [MaintenanceJob.STAFF_INVITE_PURGE]: 26 * 3600, // daily
  [MaintenanceJob.SUBSCRIPTION_BILLING]: 26 * 3600, // daily
  [MaintenanceJob.ORG_STATEMENTS]: 26 * 3600, // daily
  [MaintenanceJob.BROADCASTS]: 5 * 60, // every minute
};

const lastRunKey = (job: MaintenanceJob) => `heartbeat:${job}`;
const firstCheckKey = (job: MaintenanceJob) => `heartbeat:watching:${job}`;

export const recordHeartbeat = async (job: MaintenanceJob, at = new Date()) => {
  await getRedis().set(lastRunKey(job), String(at.getTime()));
};

export type JobHealth = { job: MaintenanceJob; lastRunAt: Date | null; stale: boolean };

/**
 * A job that has never reported counts from the first time anyone checked, so a fresh deploy (or the
 * daily job before its first run) isn't flagged right away — but one that never starts still is.
 */
export const jobHealth = async (now = new Date()): Promise<JobHealth[]> => {
  const redis = getRedis();
  const result: JobHealth[] = [];
  for (const job of Object.values(MaintenanceJob)) {
    const raw = await redis.get(lastRunKey(job));
    let since = raw ? Number(raw) : null;
    if (since === null) {
      await redis.set(firstCheckKey(job), String(now.getTime()), 'NX');
      since = Number(await redis.get(firstCheckKey(job)));
    }
    result.push({
      job,
      lastRunAt: raw ? new Date(Number(raw)) : null,
      stale: now.getTime() - since > MAX_SILENCE_SECONDS[job] * 1000,
    });
  }
  return result;
};
