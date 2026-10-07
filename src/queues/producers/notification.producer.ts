import { getQueue } from '../queue-registry';
import { QueueName } from '../queue-names';
import type { SendNotificationJob } from '../jobs/notification.job';

export const enqueueNotification = (job: SendNotificationJob) =>
  getQueue(QueueName.NOTIFICATIONS).add('send', job);
