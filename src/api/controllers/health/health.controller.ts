import { Router, type Request, type Response } from 'express';
import mongoose from 'mongoose';
import type IBaseController from '../interfaces/base-controller.interface';
import { z } from '../../validations/zod';
import { defineRoute } from '../../../docs/openapi';
import { HttpResponse } from '../../../utils/response/http-response';

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
};

export default class HealthController implements IBaseController {
  path = '/health';
  router = Router();

  constructor() {
    this.initializeRoutes();
  }

  initializeRoutes() {
    this.router.get(routes.health.path, this.health.bind(this));
  }

  private health(_req: Request, res: Response) {
    return HttpResponse.ok(res, {
      uptime: process.uptime(),
      db: mongoose.connection.readyState === 1 ? 'up' : 'down',
      timestamp: new Date().toISOString(),
    });
  }
}
