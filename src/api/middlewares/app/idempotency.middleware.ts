import { createHash } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { getRedis } from '../../../config/redis.config';
import { ConflictError, IdempotencyKeyReusedError, ValidationError } from '../../../utils/types-errors';

const HEADER = 'Idempotency-Key';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** How long a finished response can be replayed. */
const DONE_TTL_SECONDS = 24 * 3600;
/** Lock while the first request runs; expires on its own if the process dies mid-request. */
const PROCESSING_TTL_SECONDS = 120;

type StoredRequest =
  { state: 'processing'; hash: string } | { state: 'done'; hash: string; status: number; body: unknown };

/**
 * Requires an `Idempotency-Key` (UUID) header and makes the route safe to retry (spec §7.0:
 * POST /bookings, POST /payments/initiate, POST /packages/{id}/subscribe).
 *
 * - Same key + same body after completion → the stored response is replayed (`Idempotent-Replayed: true`).
 * - Same key while the first request is still running → 409 CONFLICT.
 * - Same key with a different body → 422 IDEMPOTENCY_KEY_REUSED.
 * - 5xx responses are not stored, so the client can retry with the same key.
 *
 * Keys are scoped per user and route, so place it after IsAuthenticatedMiddleware.
 * Fails closed: if Redis is unavailable the request errors instead of risking a duplicate.
 */
export const IdempotencyMiddleware = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const key = req.header(HEADER);
    if (!key || !UUID.test(key)) {
      return next(new ValidationError({ [HEADER]: ['validation.idempotency_key'] }));
    }

    const redis = getRedis();
    const route = req.originalUrl.split('?')[0];
    const redisKey = `idem:${req.user?.id ?? 'anon'}:${req.method}:${route}:${key}`;
    const hash = createHash('sha256')
      .update(JSON.stringify(req.body ?? null))
      .digest('hex');

    const processing: StoredRequest = { state: 'processing', hash };
    const acquired = await redis.set(
      redisKey,
      JSON.stringify(processing),
      'EX',
      PROCESSING_TTL_SECONDS,
      'NX',
    );

    if (!acquired) {
      const raw = await redis.get(redisKey);
      if (!raw) return next(new ConflictError('errors.request_in_progress')); // expired between calls; client retries
      const stored = JSON.parse(raw) as StoredRequest;
      if (stored.hash !== hash) return next(new IdempotencyKeyReusedError());
      if (stored.state === 'processing') return next(new ConflictError('errors.request_in_progress'));

      res.status(stored.status).setHeader('Idempotent-Replayed', 'true');
      return stored.body === undefined ? res.end() : res.json(stored.body);
    }

    let body: unknown;
    const json = res.json.bind(res);
    res.json = (payload: unknown) => {
      body = payload;
      return json(payload);
    };

    res.on('finish', () => {
      const done: StoredRequest = { state: 'done', hash, status: res.statusCode, body };
      const write =
        res.statusCode >= 500
          ? redis.del(redisKey)
          : redis.set(redisKey, JSON.stringify(done), 'EX', DONE_TTL_SECONDS);
      // Response is already sent; on failure the processing lock simply expires.
      write.catch(() => undefined);
    });

    next();
  } catch (err) {
    next(err);
  }
};
