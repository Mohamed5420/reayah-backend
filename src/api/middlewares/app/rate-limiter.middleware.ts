import rateLimit from 'express-rate-limit';
import { TooManyRequestsError } from '../../../utils/types-errors';

/** In-memory backstop. Swap the store for a Redis store when running more than one instance. */
export const RateLimiterMiddleware = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_req, _res, next) => next(new TooManyRequestsError()),
});
