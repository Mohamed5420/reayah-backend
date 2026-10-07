import { Queue, type Worker } from 'bullmq';
import { redisConnection } from '../config/redis.config';
import { QueueName } from './queue-names';
import { defaultJobOptions } from './retention';
import { createNotificationWorker } from './workers/notification.worker';
import { createMaintenanceWorker } from './workers/maintenance.worker';
import { logger } from '../utils/logger/winston';

const queues = new Map<QueueName, Queue>();
const workers: Worker[] = [];

/** Lazily creates (once) and returns the queue for a name. */
export const getQueue = (name: QueueName): Queue => {
  let queue = queues.get(name);
  if (!queue) {
    queue = new Queue(name, { connection: redisConnection, defaultJobOptions });
    queue.on('error', (err) => logger.error(`Queue "${name}" error`, err));
    queues.set(name, queue);
  }
  return queue;
};

export const getAllQueues = (): Queue[] => Object.values(QueueName).map(getQueue);

export const initQueues = () => {
  getAllQueues();
  workers.push(createNotificationWorker(), createMaintenanceWorker());
  for (const worker of workers) {
    worker.on('failed', (job, err) => logger.error(`Job ${worker.name}/${job?.name}#${job?.id} failed`, err));
    worker.on('error', (err) => logger.error(`Worker "${worker.name}" error`, err));
  }
  logger.info(`Queues ready: ${[...queues.keys()].join(', ')}`);
};

export const shutdownQueues = async () => {
  await Promise.allSettled(workers.map((w) => w.close()));
  await Promise.allSettled([...queues.values()].map((q) => q.close()));
  logger.info('Queues shut down');
};
