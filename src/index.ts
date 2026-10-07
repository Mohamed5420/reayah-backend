import 'reflect-metadata'; // must stay first — TypeDI decorators depend on it
import './instrument'; // Sentry — before anything else loads
import * as Sentry from '@sentry/node';
import { Server } from './server';
import { getGlobalControllers } from './api/controllers';
import { disconnectDB } from './database';
import { PresenceCleanup } from './helper/presence-cleanup';
import { shutdownQueues } from './queues/queue-registry';
import { closeRedis } from './config/redis.config';
import { setupScheduledTasks } from './utils/scheduled-tasks';
import { logger } from './utils/logger/winston';

const bootstrap = async () => {
  const server = new Server(getGlobalControllers());

  await server.initDatabase();
  await PresenceCleanup.cleanStalePresence();
  await server.runServer();
  await setupScheduledTasks();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received — shutting down`);
    try {
      await server.close();
      await PresenceCleanup.cleanStalePresence();
      await shutdownQueues();
      await closeRedis();
      await disconnectDB();
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
};

/** Report to Sentry and give it a moment to send before the process dies. */
const reportAndExit = async (message: string, err: unknown) => {
  logger.error(message, err);
  Sentry.captureException(err);
  await Sentry.flush(2000);
  process.exit(1);
};

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', reason);
  Sentry.captureException(reason);
});
process.on('uncaughtException', (err) => void reportAndExit('Uncaught exception', err));

bootstrap().catch((err) => reportAndExit('Bootstrap failed', err));
