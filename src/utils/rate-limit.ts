import { getRedis } from '../config/redis.config';

/**
 * Fixed-window counter in Redis. Returns true when this hit goes over `limit` within the window.
 * Redis errors propagate on purpose: callers guarding paid actions (SMS) should fail closed.
 */
export const isOverLimit = async (key: string, limit: number, windowSeconds: number): Promise<boolean> => {
  const redis = getRedis();
  const count = await redis.incr(`ratelimit:${key}`);
  if (count === 1) await redis.expire(`ratelimit:${key}`, windowSeconds);
  return count > limit;
};
