import { Router, type NextFunction, type Request, type Response } from 'express';
import { Container } from 'typedi';
import type IBaseController from '../interfaces/base-controller.interface';
import { PublicCacheMiddleware } from '../../middlewares/app';
import { z } from '../../validations/zod';
import { defineRoute } from '../../../docs/openapi';
import { SettingsService } from '../../../services/settings';
import { HttpResponse } from '../../../utils/response/http-response';
import { resolveLanguage, t } from '../../../utils/i18n';

const routes = {
  appConfig: defineRoute({
    method: 'get',
    path: '/app-config',
    summary: 'Startup config: min app versions, support/emergency numbers, policies, feature flags',
    tags: ['Lookups'],
    response: {
      schema: z
        .object({
          min_app_version: z.object({ android: z.string(), ios: z.string() }),
          support_phone: z.string(),
          emergency_number: z.string().openapi({ example: '123' }),
          cancellation_free_window_hours: z.number(),
          cancellation_policy: z.string(),
          direct_request_response_minutes: z.number(),
          features: z.object({
            video_consult: z.boolean(),
            card_payment: z.boolean(),
            packages: z.boolean(),
          }),
        })
        .openapi('AppConfig'),
    },
  }),
};

/**
 * Called on splash (spec §7.16). Deliberately not behind CheckAppStatusMiddleware, so the app can
 * still load its config (and show the support number) during maintenance.
 */
export default class AppConfigController implements IBaseController {
  path = '/app-config';
  router = Router();

  private settings = Container.get(SettingsService);

  constructor() {
    this.initializeRoutes();
  }

  initializeRoutes() {
    // Short cache: admins expect setting changes (e.g. a feature flag) to reach apps quickly.
    this.router.get(routes.appConfig.path, PublicCacheMiddleware(60), this.appConfig.bind(this));
  }

  private async appConfig(req: Request, res: Response, next: NextFunction) {
    try {
      const s = await this.settings.getAll();
      return HttpResponse.ok(res, {
        min_app_version: s.min_app_version,
        support_phone: s.support_phone,
        emergency_number: s.emergency_number,
        cancellation_free_window_hours: s.cancellation_free_window_hours,
        cancellation_policy: t(
          'app_config.cancellation_policy',
          { hours: s.cancellation_free_window_hours },
          resolveLanguage(req),
        ),
        direct_request_response_minutes: s.direct_request_response_minutes,
        features: s.features,
      });
    } catch (err) {
      next(err);
    }
  }
}
