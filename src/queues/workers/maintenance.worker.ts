import { Worker } from 'bullmq';
import { Container } from 'typedi';
import { BookingDeadlineService } from '../../services/booking/booking-deadline.service';
import { BookingReminderService } from '../../services/booking/booking-reminder.service';
import { AccountService } from '../../services/moderation/account.service';
import { DocumentExpiryService } from '../../services/provider/document-expiry.service';
import { PaymentService } from '../../services/payments/payment.service';
import { PayoutService } from '../../services/payouts/payout.service';
import { PackageService } from '../../services/marketing/package.service';
import { BroadcastService } from '../../services/marketing/broadcast.service';
import { StaffService } from '../../services/organization/staff.service';
import { SubscriptionService } from '../../services/organization/subscription.service';
import { StatementService } from '../../services/organization/statement.service';
import { redisConnection } from '../../config/redis.config';
import { MaintenanceJob, QueueName } from '../queue-names';
import { recordHeartbeat } from '../heartbeat';
import { logger } from '../../utils/logger/winston';

/** Runs one scheduled job and records its heartbeat (only on success, so failures show up as staleness). */
export const runMaintenanceJob = async (name: string) => {
  switch (name as MaintenanceJob) {
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
    case MaintenanceJob.PAYMENT_EXPIRY:
      await Container.get(PaymentService).expireUnpaid();
      break;
    case MaintenanceJob.PAYOUT_BATCH:
      await Container.get(PayoutService).runScheduled();
      break;
    case MaintenanceJob.SUBSCRIPTION_BILLING:
      await Container.get(SubscriptionService).billDue();
      await Container.get(SubscriptionService).processUnpaid();
      break;
    case MaintenanceJob.ORG_STATEMENTS:
      await Container.get(StatementService).runDaily();
      break;
    case MaintenanceJob.BROADCASTS:
      await Container.get(BroadcastService).processDue();
      break;
    case MaintenanceJob.STAFF_INVITE_PURGE:
      await Container.get(StaffService).purgeLapsed();
      break;
    case MaintenanceJob.PACKAGE_EXPIRY:
      await Container.get(PackageService).processDue();
      break;
    case MaintenanceJob.DOCUMENT_EXPIRY:
      await Container.get(DocumentExpiryService).processDaily();
      break;
    default:
      logger.warn(`Maintenance: unknown job "${name}"`);
      return;
  }
  await recordHeartbeat(name as MaintenanceJob);
};

/** Processes scheduled (cron) jobs. One case per MaintenanceJob. */
export const createMaintenanceWorker = () =>
  new Worker(QueueName.MAINTENANCE, (job) => runMaintenanceJob(job.name), {
    connection: redisConnection,
    concurrency: 1,
  });
