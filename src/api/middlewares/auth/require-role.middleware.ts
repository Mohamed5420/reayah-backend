import type { NextFunction, Request, Response } from 'express';
import type { UserRole } from '../../../interfaces/enums';
import { ForbiddenError, UnauthorizedError } from '../../../utils/types-errors';

/** 403 FORBIDDEN unless `req.user.role` is one of `roles` (spec §2: one role per account). */
export const RequireRole =
  (...roles: UserRole[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new UnauthorizedError());
    if (!roles.includes(req.user.role)) return next(new ForbiddenError());
    next();
  };
