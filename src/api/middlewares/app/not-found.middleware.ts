import type { NextFunction, Request, Response } from 'express';
import { NotFoundError } from '../../../utils/types-errors';

export const NotFoundMiddleware = (_req: Request, _res: Response, next: NextFunction) => {
  next(new NotFoundError('errors.route_not_found'));
};
