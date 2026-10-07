import { Router, type NextFunction, type Request, type Response } from 'express';
import { Container } from 'typedi';
import type IBaseController from '../interfaces/base-controller.interface';
import { CheckAppStatusMiddleware, PublicCacheMiddleware } from '../../middlewares/app';
import { LocationSchemas } from '../../validations/location/location.validation';
import { z } from '../../validations/zod';
import {
  presentArea,
  presentAreaSearchResult,
  presentGovernorate,
} from '../../presenters/location.presenter';
import { defineRoute } from '../../../docs/openapi';
import { LocationService } from '../../../services/location';
import { HttpResponse } from '../../../utils/response/http-response';
import { parsePagination } from '../../../utils/response/pagination';
import { resolveLanguage } from '../../../utils/i18n';

const tags = ['Lookups'];

const routes = {
  governorates: defineRoute({
    method: 'get',
    path: '/governorates',
    summary: 'Active governorates',
    tags,
    response: { schema: z.array(LocationSchemas.governorate) },
  }),
  areasOfGovernorate: defineRoute({
    method: 'get',
    path: '/governorates/:id/areas',
    summary: 'Active areas of a governorate (address form picker)',
    tags,
    request: { params: LocationSchemas.idParams },
    response: { schema: z.array(LocationSchemas.area) },
  }),
  searchAreas: defineRoute({
    method: 'get',
    path: '/areas',
    summary: 'Search active areas (provider coverage multi-select). Tolerates Arabic spelling variants.',
    tags,
    request: { query: LocationSchemas.areaSearchQuery },
    response: { schema: LocationSchemas.areaSearchResult, paginated: true },
  }),
};

/** Public location lookups (spec §7.3). Text only — no coordinates (§1). */
export default class LocationController implements IBaseController {
  path = '/';
  router = Router();

  private locations = Container.get(LocationService);

  constructor() {
    this.initializeRoutes();
  }

  initializeRoutes() {
    const publicChain = [CheckAppStatusMiddleware, PublicCacheMiddleware()];

    this.router.get(routes.governorates.path, ...publicChain, this.governorates.bind(this));
    this.router.get(
      routes.areasOfGovernorate.path,
      ...publicChain,
      routes.areasOfGovernorate.validate,
      this.areasOfGovernorate.bind(this),
    );
    this.router.get(
      routes.searchAreas.path,
      ...publicChain,
      routes.searchAreas.validate,
      this.searchAreas.bind(this),
    );
  }

  private async governorates(req: Request, res: Response, next: NextFunction) {
    try {
      const lang = resolveLanguage(req);
      const governorates = await this.locations.activeGovernorates();
      return HttpResponse.ok(
        res,
        governorates.map((g) => presentGovernorate(g, lang)),
      );
    } catch (err) {
      next(err);
    }
  }

  private async areasOfGovernorate(req: Request, res: Response, next: NextFunction) {
    try {
      const lang = resolveLanguage(req);
      const areas = await this.locations.activeAreasOf(req.params.id);
      return HttpResponse.ok(
        res,
        areas.map((a) => presentArea(a, lang)),
      );
    } catch (err) {
      next(err);
    }
  }

  private async searchAreas(req: Request, res: Response, next: NextFunction) {
    try {
      const lang = resolveLanguage(req);
      const query = req.query as z.infer<typeof LocationSchemas.areaSearchQuery>;
      const pagination = parsePagination(req.query);
      const { data, total } = await this.locations.searchAreas(
        { search: query.search, governorateId: query.governorate_id },
        pagination,
      );
      return HttpResponse.paginated(
        res,
        data.map((a) => presentAreaSearchResult(a, lang)),
        pagination,
        total,
      );
    } catch (err) {
      next(err);
    }
  }
}
