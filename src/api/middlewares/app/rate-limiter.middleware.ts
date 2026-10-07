import type { NextFunction, Request, Response } from 'express';
import { env } from '../../../config/env.config';
import { isOverLimit } from '../../../utils/rate-limit';
import { logger } from '../../../utils/logger/winston';
import { TooManyRequestsError } from '../../../utils/types-errors';

/**
 * Fixed-window limit per client IP, counted in Redis so it holds across instances (spec §9).
 * Fails open: if Redis is down the request goes through (logged) — the API shouldn't go down with
 * the limiter. Paid or sensitive actions (OTP SMS, uploads) have their own fail-closed limits.
 */
export const RateLimit = (name: string, limit: number, windowSeconds: number) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    let over = false;
    try {
      over = await isOverLimit(`${name}:${req.ip ?? 'unknown'}`, limit, windowSeconds);
    } catch (err) {
      logger.warn(`Rate limiter "${name}" unavailable, letting the request through`, err);
    }
    if (!over) return next();
    res.setHeader('Retry-After', String(windowSeconds));
    return next(new TooManyRequestsError());
  };
};

/** Every API request: `RATE_LIMIT_PER_MINUTE` (default 300) per IP. */
export const RateLimiterMiddleware = RateLimit('api', env.rateLimit.perMinute, 60);

/**
 * Public auth endpoints (OTP, register, refresh, logout): `RATE_LIMIT_AUTH_PER_MINUTE` (default 30) per IP,
 * on top of the OTP service's own per-phone / per-IP SMS limits.
 */
export const AuthRateLimiterMiddleware = RateLimit('auth', env.rateLimit.authPerMinute, 60);
