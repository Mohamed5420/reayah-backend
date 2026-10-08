import type { NextFunction, Request, Response } from 'express';
import { UserModel } from '../../../database/models/user/user.model';
import { UserStatus } from '../../../interfaces/enums';
import { AccountSuspendedError, UnauthorizedError } from '../../../utils/types-errors';

/**
 * Must run after IsAuthenticatedMiddleware. Access tokens live up to an hour, so the account's current
 * status is checked on every request: suspended → 403 ACCOUNT_SUSPENDED, deleted → 401. The current role
 * replaces the token's too (a provider joining or leaving an organization switches role mid-session).
 */
export const RequireActiveAccountMiddleware = async (req: Request, _res: Response, next: NextFunction) => {
  try {
    if (!req.user) return next(new UnauthorizedError());
    const user = await UserModel.findById(req.user.id).select('status role').lean();
    if (!user || user.status === UserStatus.DELETED) return next(new UnauthorizedError());
    if (user.status !== UserStatus.ACTIVE) return next(new AccountSuspendedError());
    req.user.role = user.role;
    next();
  } catch (err) {
    next(err);
  }
};
