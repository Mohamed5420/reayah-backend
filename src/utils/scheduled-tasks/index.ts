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
    { id: MaintenanceJob.DOCUMENT_EXPIRY, repeat: { pattern: '0 6 * * *', tz: 'Africa/Cairo' } }, // daily 06:00 Cairo
  ];

export const setupScheduledTasks = async () => {
  const queue = getQueue(QueueName.MAINTENANCE);
  for (const { id, repeat } of schedules) {
    await queue.upsertJobScheduler(id, repeat, { name: id });
  }
  logger.info(`Scheduled tasks registered: ${schedules.map((s) => s.id).join(', ')}`);
};
