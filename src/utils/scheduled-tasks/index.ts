import { getQueue } from '../../queues/queue-registry';
import { MaintenanceJob, QueueName } from '../../queues/queue-names';
import { logger } from '../logger/winston';

/**
 * Cron jobs as BullMQ job schedulers — safe across multiple instances
 * (upsert by id, so restarts don't duplicate them).
 */
const schedules: Array<{ id: MaintenanceJob; repeat: { pattern: string; tz?: string } | { every: number } }> =
  [
    { id: MaintenanceJob.PRESENCE_CLEANUP, repeat: { pattern: '0 * * * *' } }, // hourly
    { id: MaintenanceJob.BOOKING_DEADLINES, repeat: { every: 30_000 } }, // every 30 s
    { id: MaintenanceJob.BOOKING_REMINDERS, repeat: { every: 60_000 } }, // every minute
    { id: MaintenanceJob.SUSPENSION_EXPIRY, repeat: { every: 5 * 60_000 } }, // every 5 min
    { id: MaintenanceJob.PAYMENT_EXPIRY, repeat: { every: 60_000 } }, // every minute
    { id: MaintenanceJob.PAYOUT_BATCH, repeat: { pattern: '0 9 * * *', tz: 'Africa/Cairo' } }, // daily 09:00 Cairo
    { id: MaintenanceJob.SUBSCRIPTION_BILLING, repeat: { pattern: '0 1 * * *', tz: 'Africa/Cairo' } }, // daily 01:00 Cairo
    { id: MaintenanceJob.ORG_STATEMENTS, repeat: { pattern: '0 2 * * *', tz: 'Africa/Cairo' } }, // daily 02:00 Cairo
    { id: MaintenanceJob.STAFF_INVITE_PURGE, repeat: { pattern: '30 3 * * *', tz: 'Africa/Cairo' } }, // daily 03:30 Cairo
    { id: MaintenanceJob.PACKAGE_EXPIRY, repeat: { pattern: '15 * * * *' } }, // hourly
    { id: MaintenanceJob.DOCUMENT_EXPIRY, repeat: { pattern: '0 6 * * *', tz: 'Africa/Cairo' } }, // daily 06:00 Cairo
  ];

export const setupScheduledTasks = async () => {
  const queue = getQueue(QueueName.MAINTENANCE);
  for (const { id, repeat } of schedules) {
    await queue.upsertJobScheduler(id, repeat, { name: id });
  }
  logger.info(`Scheduled tasks registered: ${schedules.map((s) => s.id).join(', ')}`);
};
