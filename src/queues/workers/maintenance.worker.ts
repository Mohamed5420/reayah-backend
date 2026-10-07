import { Worker } from 'bullmq';
import { Container } from 'typedi';
import { BookingDeadlineService } from '../../services/booking/booking-deadline.service';
import { BookingReminderService } from '../../services/booking/booking-reminder.service';
import { AccountService } from '../../services/moderation/account.service';
import { DocumentExpiryService } from '../../services/provider/document-expiry.service';
import { redisConnection } from '../../config/redis.config';
import { MaintenanceJob, QueueName } from '../queue-names';
import { logger } from '../../utils/logger/winston';

/** Processes scheduled (cron) jobs. One case per MaintenanceJob. */
export const createMaintenanceWorker = () =>
  new Worker(
    QueueName.MAINTENANCE,
    async (job) => {
      switch (job.name as MaintenanceJob) {
        case MaintenanceJob.PRESENCE_CLEANUP:
          // Placeholder: e.g. reconcile isOnline with live sockets.
          logger.debug('Maintenance: presence-cleanup tick');
          break;
        case MaintenanceJob.BOOKING_DEADLINES:
          await Container.get(BookingDeadlineService).processDue();
          break;
        case MaintenanceJob.BOOKING_REMINDERS:
          await Container.get(BookingReminderService).processDue();
          break;
        case MaintenanceJob.SUSPENSION_EXPIRY:
          await Container.get(AccountService).liftExpired();
          break;
        case MaintenanceJob.DOCUMENT_EXPIRY:
          await Container.get(DocumentExpiryService).processDaily();
          break;
        default:
          logger.warn(`Maintenance: unknown job "${job.name}"`);
      }
    },
    { connection: redisConnection, concurrency: 1 },
  );
