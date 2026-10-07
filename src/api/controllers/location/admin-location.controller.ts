import { Router, type NextFunction, type Request, type Response } from 'express';
import { Container } from 'typedi';
import type IBaseController from '../interfaces/base-controller.interface';
import { CheckAppStatusMiddleware } from '../../middlewares/app';
import { AdminGuard } from '../../middlewares/auth';
import { LocationSchemas } from '../../validations/location/location.validation';
import type { z } from '../../validations/zod';
import { presentAdminArea, presentAdminGovernorate } from '../../presenters/location.presenter';
import { defineRoute } from '../../../docs/openapi';
import { LocationAdminService, type AreaInput, type GovernorateInput } from '../../../services/location';
import { auditContextFrom } from '../../../services/audit';
import { HttpResponse } from '../../../utils/response/http-response';
import { parsePagination } from '../../../utils/response/pagination';
import { camelizeKeys } from '../../../utils/case';

const tags = ['Admin — Locations'];
const auth = true;

const routes = {
  listGovernorates: defineRoute({
    method: 'get',
    path: '/admin/governorates',
    summary: 'List governorates (incl. inactive)',
    tags,
    auth,
    request: { query: LocationSchemas.adminGovernorateQuery },
    response: { schema: LocationSchemas.adminGovernorate, paginated: true },
  }),
  createGovernorate: defineRoute({
    method: 'post',
    path: '/admin/governorates',
    summary: 'Create a governorate',
    tags,
    auth,
    request: { body: LocationSchemas.createGovernorateBody },
    response: { status: 201, schema: LocationSchemas.adminGovernorate },
  }),
  updateGovernorate: defineRoute({
    method: 'patch',
    path: '/admin/governorates/:id',
    summary: 'Update / activate / deactivate a governorate',
    tags,
    auth,
    request: { params: LocationSchemas.idParams, body: LocationSchemas.updateGovernorateBody },
    response: { schema: LocationSchemas.adminGovernorate },
  }),
  listAreas: defineRoute({
    method: 'get',
    path: '/admin/areas',
    summary: 'List areas (incl. inactive)',
    tags,
    auth,
    request: { query: LocationSchemas.adminAreaQuery },
    response: { schema: LocationSchemas.adminArea, paginated: true },
  }),
  createArea: defineRoute({
    method: 'post',
    path: '/admin/areas',
    summary: 'Create an area',
    tags,
    auth,
    request: { body: LocationSchemas.createAreaBody },
    response: { status: 201, schema: LocationSchemas.adminArea },
  }),
  updateArea: defineRoute({
    method: 'patch',
    path: '/admin/areas/:id',
    summary: 'Update / activate / deactivate an area, or set its travel-fee cap',
    tags,
    auth,
    request: { params: LocationSchemas.idParams, body: LocationSchemas.updateAreaBody },
    response: { schema: LocationSchemas.adminArea },
  }),
};

/** Admin panel: governorates and areas (spec §7.15 "Catalog & locations"). */
export default class AdminLocationController implements IBaseController {
  path = '/admin';
  router = Router();

  private admin = Container.get(LocationAdminService);

  constructor() {
    this.initializeRoutes();
  }

  initializeRoutes() {
    for (const [route, handler] of [
      [routes.listGovernorates, this.listGovernorates],
      [routes.createGovernorate, this.createGovernorate],
      [routes.updateGovernorate, this.updateGovernorate],
      [routes.listAreas, this.listAreas],
      [routes.createArea, this.createArea],
      [routes.updateArea, this.updateArea],
    ] as const) {
      this.router[route.method](
        route.path,
        CheckAppStatusMiddleware,
        route.validate,
        ...AdminGuard,
        handler.bind(this),
      );
    }
  }

  private async listGovernorates(req: Request, res: Response, next: NextFunction) {
    try {
      const query = req.query as z.infer<typeof LocationSchemas.adminGovernorateQuery>;
      const pagination = parsePagination(req.query);
      const { data, total } = await this.admin.listGovernorates(
        { isActive: query.is_active, search: query.search },
        pagination,
      );
      return HttpResponse.paginated(res, data.map(presentAdminGovernorate), pagination, total);
    } catch (err) {
      next(err);
    }
  }

  private async createGovernorate(req: Request, res: Response, next: NextFunction) {
    try {
      const input = camelizeKeys(req.body) as GovernorateInput;
      const governorate = await this.admin.createGovernorate(input, auditContextFrom(req));
      return HttpResponse.created(res, presentAdminGovernorate(governorate));
    } catch (err) {
      next(err);
    }
  }

  private async updateGovernorate(req: Request, res: Response, next: NextFunction) {
    try {
      const patch = camelizeKeys(req.body) as Partial<GovernorateInput>;
      const governorate = await this.admin.updateGovernorate(req.params.id, patch, auditContextFrom(req));
      return HttpResponse.ok(res, presentAdminGovernorate(governorate));
    } catch (err) {
      next(err);
    }
  }

  private async listAreas(req: Request, res: Response, next: NextFunction) {
    try {
      const query = req.query as z.infer<typeof LocationSchemas.adminAreaQuery>;
      const pagination = parsePagination(req.query);
      const { data, total } = await this.admin.listAreas(
        { governorateId: query.governorate_id, isActive: query.is_active, search: query.search },
        pagination,
      );
      return HttpResponse.paginated(res, data.map(presentAdminArea), pagination, total);
    } catch (err) {
      next(err);
    }
  }

  private async createArea(req: Request, res: Response, next: NextFunction) {
    try {
      const input = camelizeKeys(req.body) as AreaInput;
      const area = await this.admin.createArea(input, auditContextFrom(req));
      return HttpResponse.created(res, presentAdminArea(area));
    } catch (err) {
      next(err);
    }
  }

  private async updateArea(req: Request, res: Response, next: NextFunction) {
    try {
      const patch = camelizeKeys(req.body) as Partial<AreaInput>;
      const area = await this.admin.updateArea(req.params.id, patch, auditContextFrom(req));
      return HttpResponse.ok(res, presentAdminArea(area));
    } catch (err) {
      next(err);
    }
  }
}
