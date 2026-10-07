import type { ConnectionOptions } from 'bullmq';
import Redis from 'ioredis';
import { env } from './env.config';
import { logger } from '../utils/logger/winston';

/** BullMQ connection options (queues and workers open their own connections). */
export const redisConnection: ConnectionOptions = {
  host: env.redis.host,
  port: env.redis.port,
  password: env.redis.password,
  maxRetriesPerRequest: null, // required by BullMQ workers
};

let client: Redis | undefined;

/**
 * Shared client for app-level use (cache, idempotency, rate limits, locks). Unlike the BullMQ
 * connection, commands fail fast instead of queueing forever while Redis is down.
 */
export const getRedis = (): Redis => {
  if (!client) {
    client = new Redis({
      host: env.redis.host,
      port: env.redis.port,
      password: env.redis.password,
      maxRetriesPerRequest: 2,
    });
    client.on('error', (err) => logger.error('Redis client error', err));
  }
  return client;
};

export const closeRedis = async () => {
  if (!client) return;
  await client.quit();
  client = undefined;
  logger.info('Redis client closed');
};
