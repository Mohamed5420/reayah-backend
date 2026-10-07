import { Router, type NextFunction, type Request, type Response } from 'express';
import mongoose from 'mongoose';
import type IBaseController from '../interfaces/base-controller.interface';
import { z } from '../../validations/zod';
import { defineRoute } from '../../../docs/openapi';
import { getRedis } from '../../../config/redis.config';
import { jobHealth } from '../../../queues/heartbeat';
import { HttpResponse } from '../../../utils/response/http-response';
import { logger } from '../../../utils/logger/winston';
import { ServiceUnavailableError } from '../../../utils/types-errors';

const routes = {
  health: defineRoute({
    method: 'get',
    path: '/health',
    summary: 'Liveness + database status',
    tags: ['System'],
    response: {
      schema: z.object({
        uptime: z.number(),
        db: z.enum(['up', 'down']),
        timestamp: z.string(),
      }),
    },
  }),
  ready: defineRoute({
    method: 'get',
    path: '/health/ready',
    summary:
      'Readiness for load balancers / uptime monitors: 200 when MongoDB and Redis answer within 2 s, otherwise 503',
    tags: ['System'],
    response: {
      schema: z.object({ mongo: z.literal('up'), redis: z.literal('up'), timestamp: z.string() }),
    },
  }),
  jobs: defineRoute({
    method: 'get',
    path: '/health/jobs',
    summary:
      'Scheduled jobs (booking deadlines, reminders, suspension lifts, document check): 200 when each ran recently, 503 when one has gone silent — point an alert at it',
    tags: ['System'],
    response: {
      schema: z.array(
        z.object({ job: z.string(), last_run_at: z.string().nullable(), stale: z.literal(false) }),
      ),
    },
  }),
};

const PING_TIMEOUT_MS = 2000;

/** Resolves true when `check` succeeds within the timeout. */
const answers = async (check: () => Promise<unknown>) => {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      check(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), PING_TIMEOUT_MS);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
};

export default class HealthController implements IBaseController {
  path = '/health';
  router = Router();

  constructor() {
    this.initializeRoutes();
  }

  initializeRoutes() {
    this.router.get(routes.health.path, this.health.bind(this));
    this.router.get(routes.ready.path, this.ready.bind(this));
    this.router.get(routes.jobs.path, this.jobs.bind(this));
  }

  private health(_req: Request, res: Response) {
    return HttpResponse.ok(res, {
      uptime: process.uptime(),
      db: mongoose.connection.readyState === 1 ? 'up' : 'down',
      timestamp: new Date().toISOString(),
    });
  }

  private async ready(_req: Request, res: Response, next: NextFunction) {
    const [mongo, redis] = await Promise.all([
      answers(async () => {
        if (mongoose.connection.readyState !== 1) throw new Error('not connected');
        await mongoose.connection.db!.admin().ping();
      }),
      answers(() => getRedis().ping()),
    ]);
    if (mongo && redis) {
      return HttpResponse.ok(res, { mongo: 'up', redis: 'up', timestamp: new Date().toISOString() });
    }
    logger.error(`Readiness check failed: mongo=${mongo ? 'up' : 'down'} redis=${redis ? 'up' : 'down'}`);
    return next(new ServiceUnavailableError());
  }

  private async jobs(_req: Request, res: Response, next: NextFunction) {
    try {
      const jobs = await jobHealth();
      const stale = jobs.filter((j) => j.stale).map((j) => j.job);
      if (stale.length) {
        logger.error(`Scheduled jobs silent for too long: ${stale.join(', ')}`);
        return next(new ServiceUnavailableError());
      }
      return HttpResponse.ok(
        res,
        jobs.map((j) => ({ job: j.job, last_run_at: j.lastRunAt?.toISOString() ?? null, stale: false })),
      );
    } catch (err) {
      next(err);
    }
  }
}
