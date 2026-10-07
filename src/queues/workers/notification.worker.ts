import { Worker, type Job } from 'bullmq';
import { getMessaging } from 'firebase-admin/messaging';
import { redisConnection } from '../../config/redis.config';
import { isFirebaseReady } from '../../config/firebase.config';
import { QueueName } from '../queue-names';
import type { SendNotificationJob } from '../jobs/notification.job';
import { sendPushToUser } from '../../services/notification/push';
import { logger } from '../../utils/logger/winston';

/**
 * Delivers queued pushes via FCM. Retries come from the queue's default job options (3 attempts,
 * exponential backoff). Without Firebase credentials (local dev) pushes are skipped — the in-app
 * notification and the socket event still happen.
 */
export const createNotificationWorker = () =>
  new Worker<SendNotificationJob>(
    QueueName.NOTIFICATIONS,
    async (job: Job<SendNotificationJob>) => {
      if (!isFirebaseReady()) {
        logger.debug(`Push skipped (Firebase disabled): ${job.data.data.type} → ${job.data.userId}`);
        return;
      }
      await sendPushToUser(getMessaging(), job.data);
    },
    { connection: redisConnection, concurrency: 10 },
  );
