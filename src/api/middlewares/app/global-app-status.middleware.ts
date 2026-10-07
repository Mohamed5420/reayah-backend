import type { NextFunction, Request, Response } from 'express';
import { ServiceUnavailableError } from '../../../utils/types-errors';

/**
 * Maintenance switch. Flip `appStatus.maintenance` at runtime (e.g. from an admin endpoint
 * or a settings document) to reject traffic on routes that use this middleware.
 */
export const appStatus = { maintenance: false };

export const CheckAppStatusMiddleware = (_req: Request, _res: Response, next: NextFunction) => {
  if (appStatus.maintenance) {
    return next(new ServiceUnavailableError('errors.maintenance'));
  }
  next();
};
