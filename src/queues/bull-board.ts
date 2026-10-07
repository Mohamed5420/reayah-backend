import type { Express, NextFunction, Request, Response } from 'express';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { getAllQueues } from './queue-registry';
import { env } from '../config/env.config';
import { logger } from '../utils/logger/winston';

const BASE_PATH = '/admin/queues';

const basicAuth = (req: Request, res: Response, next: NextFunction) => {
  const [scheme, encoded] = (req.headers.authorization ?? '').split(' ');
  if (scheme === 'Basic' && encoded) {
    const [user, pass] = Buffer.from(encoded, 'base64').toString().split(':');
    if (user === env.bullBoard.user && pass === env.bullBoard.password) return next();
  }
  res.setHeader('WWW-Authenticate', 'Basic realm="queues"').status(401).send('Unauthorized');
};

export const initializeBullBoard = (app: Express) => {
  if (!env.bullBoard.password) {
    logger.warn('BULL_BOARD_PASSWORD not set — Bull Board disabled');
    return;
  }

  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath(BASE_PATH);
  createBullBoard({ queues: getAllQueues().map((q) => new BullMQAdapter(q)), serverAdapter });
  app.use(BASE_PATH, basicAuth, serverAdapter.getRouter());
};
