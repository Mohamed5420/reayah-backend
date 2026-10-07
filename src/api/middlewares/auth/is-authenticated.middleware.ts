import type { NextFunction, Request, Response } from 'express';
import { verifyAccessToken } from '../../../services/auth/jwt';
import { UnauthorizedError } from '../../../utils/types-errors';

/** Requires `Authorization: Bearer <access token>`; sets `req.user`. 401 TOKEN_EXPIRED tells the app to refresh. */
export const IsAuthenticatedMiddleware = (req: Request, _res: Response, next: NextFunction) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return next(new UnauthorizedError());
  try {
    req.user = verifyAccessToken(header.slice(7));
    next();
  } catch (err) {
    next(err);
  }
};
