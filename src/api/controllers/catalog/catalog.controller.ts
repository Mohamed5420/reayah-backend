import { Router, type NextFunction, type Request, type Response } from 'express';
import { Container } from 'typedi';
import type IBaseController from '../interfaces/base-controller.interface';
import { CheckAppStatusMiddleware, PublicCacheMiddleware } from '../../middlewares/app';
import { CatalogSchemas } from '../../validations/catalog/catalog.validation';
import { specialtyView, z } from '../../validations/zod';
import { presentCategory, presentService } from '../../presenters/catalog.presenter';
import { defineRoute } from '../../../docs/openapi';
import { CatalogService } from '../../../services/catalog';
import { SPECIALTIES, presentSpecialty } from '../../../services/catalog/specialties';
import { HttpResponse } from '../../../utils/response/http-response';
import { resolveLanguage } from '../../../utils/i18n';

const tags = ['Lookups'];

const routes = {
  categories: defineRoute({
    method: 'get',
    path: '/service-categories',
    summary: 'Active service categories',
    tags,
    response: { schema: z.array(CatalogSchemas.category) },
  }),
  services: defineRoute({
    method: 'get',
    path: '/services',
    summary: 'Active services, optionally filtered by category / provider type',
    tags,
    request: { query: CatalogSchemas.servicesQuery },
    response: { schema: z.array(CatalogSchemas.service) },
  }),
  service: defineRoute({
    method: 'get',
    path: '/services/:id',
    summary: 'Service details',
    tags,
    request: { params: CatalogSchemas.idParams },
    response: { schema: CatalogSchemas.service },
  }),
  specialties: defineRoute({
    method: 'get',
    path: '/specialties',
    summary: 'Doctor specialties — for the doctor profile and the search filter',
    tags,
    response: { schema: z.array(specialtyView.unwrap()) },
  }),
};

/** Public service catalog (spec §7.3). */
export default class CatalogController implements IBaseController {
  path = '/';
  router = Router();

  private catalog = Container.get(CatalogService);

  constructor() {
    this.initializeRoutes();
  }

  initializeRoutes() {
    const publicChain = [CheckAppStatusMiddleware, PublicCacheMiddleware()];

    this.router.get(routes.categories.path, ...publicChain, this.categories.bind(this));
    this.router.get(routes.services.path, ...publicChain, routes.services.validate, this.services.bind(this));
    this.router.get(routes.service.path, ...publicChain, routes.service.validate, this.service.bind(this));
    this.router.get(routes.specialties.path, ...publicChain, (req: Request, res: Response) =>
      HttpResponse.ok(
        res,
        SPECIALTIES.map((s) => presentSpecialty(s.key, resolveLanguage(req))),
      ),
    );
  }

  private async categories(req: Request, res: Response, next: NextFunction) {
    try {
      const lang = resolveLanguage(req);
      const categories = await this.catalog.activeCategories();
      return HttpResponse.ok(
        res,
        categories.map((c) => presentCategory(c, lang)),
      );
    } catch (err) {
      next(err);
    }
  }

  private async services(req: Request, res: Response, next: NextFunction) {
    try {
      const lang = resolveLanguage(req);
      const query = req.query as z.infer<typeof CatalogSchemas.servicesQuery>;
      const [services, startingPrices] = await Promise.all([
        this.catalog.activeServices({ categoryId: query.category_id, providerType: query.provider_type }),
        this.catalog.startingPrices(),
      ]);
      return HttpResponse.ok(
        res,
        services.map((s) => presentService(s, lang, startingPrices)),
      );
    } catch (err) {
      next(err);
    }
  }

  private async service(req: Request, res: Response, next: NextFunction) {
    try {
      const service = await this.catalog.getActiveService(req.params.id);
      return HttpResponse.ok(
        res,
        presentService(service, resolveLanguage(req), await this.catalog.startingPrices()),
      );
    } catch (err) {
      next(err);
    }
  }
}
