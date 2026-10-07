import { getRedis } from '../../config/redis.config';
import { logger } from '../logger/winston';

/**
 * Read-through Redis cache grouped in namespaces. Each namespace has a version number that is part of
 * every key, so `invalidateCacheNamespace()` drops all of its entries in one step (old keys just expire).
 * Values must be JSON-serializable (ObjectIds/Dates come back as strings). If Redis fails, `load` runs directly.
 */
export const cached = async <T>(
  namespace: string,
  key: string,
  ttlSeconds: number,
  load: () => Promise<T>,
): Promise<T> => {
  let fullKey: string | undefined;
  try {
    const redis = getRedis();
    const version = (await redis.get(versionKey(namespace))) ?? '0';
    fullKey = `cache:${namespace}:${version}:${key}`;
    const hit = await redis.get(fullKey);
    if (hit) return JSON.parse(hit) as T;
  } catch (err) {
    logger.warn(`Cache read failed (${namespace}:${key})`, err);
  }

  const value = await load();
  if (fullKey) {
    getRedis()
      .set(fullKey, JSON.stringify(value), 'EX', ttlSeconds)
      .catch((err: unknown) => logger.warn(`Cache write failed (${namespace}:${key})`, err));
  }
  return value;
};

/** Call after every write that changes data in the namespace. A failure leaves entries stale until their TTL. */
export const invalidateCacheNamespace = async (namespace: string) => {
  try {
    await getRedis().incr(versionKey(namespace));
  } catch (err) {
    logger.error(`Cache invalidation failed for "${namespace}" — stale until TTL`, err);
  }
};

const versionKey = (namespace: string) => `cache:${namespace}:version`;
