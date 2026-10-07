import { Router, type NextFunction, type Request, type Response } from 'express';
import { Container } from 'typedi';
import type IBaseController from '../interfaces/base-controller.interface';
import { CheckAppStatusMiddleware } from '../../middlewares/app';
import { AdminGuard } from '../../middlewares/auth';
import { CatalogSchemas } from '../../validations/catalog/catalog.validation';
import { z } from '../../validations/zod';
import { presentAdminCategory, presentAdminService } from '../../presenters/catalog.presenter';
import { defineRoute } from '../../../docs/openapi';
import { CatalogAdminService, type CategoryInput, type ServiceInput } from '../../../services/catalog';
import { auditContextFrom } from '../../../services/audit';
import { HttpResponse } from '../../../utils/response/http-response';
import { parsePagination } from '../../../utils/response/pagination';
import { camelizeKeys } from '../../../utils/case';

const tags = ['Admin — Catalog'];
const auth = true;

const routes = {
  listCategories: defineRoute({
    method: 'get',
    path: '/admin/service-categories',
    summary: 'List service categories (incl. inactive)',
    tags,
    auth,
    response: { schema: z.array(CatalogSchemas.adminCategory) },
  }),
  createCategory: defineRoute({
    method: 'post',
    path: '/admin/service-categories',
    summary: 'Create a service category',
    tags,
    auth,
    request: { body: CatalogSchemas.createCategoryBody },
    response: { status: 201, schema: CatalogSchemas.adminCategory },
  }),
  updateCategory: defineRoute({
    method: 'patch',
    path: '/admin/service-categories/:id',
    summary: 'Update / activate / deactivate a service category',
    tags,
    auth,
    request: { params: CatalogSchemas.idParams, body: CatalogSchemas.updateCategoryBody },
    response: { schema: CatalogSchemas.adminCategory },
  }),
  deleteCategory: defineRoute({
    method: 'delete',
    path: '/admin/service-categories/:id',
    summary: 'Delete an empty service category (409 while it still has services)',
    tags,
    auth,
    request: { params: CatalogSchemas.idParams },
    response: { status: 204 },
  }),
  listServices: defineRoute({
    method: 'get',
    path: '/admin/services',
    summary: 'List services (incl. inactive)',
    tags,
    auth,
    request: { query: CatalogSchemas.adminServicesQuery },
    response: { schema: CatalogSchemas.adminService, paginated: true },
  }),
  createService: defineRoute({
    method: 'post',
    path: '/admin/services',
    summary: 'Create a service',
    tags,
    auth,
    request: { body: CatalogSchemas.createServiceBody },
    response: { status: 201, schema: CatalogSchemas.adminService },
  }),
  updateService: defineRoute({
    method: 'patch',
    path: '/admin/services/:id',
    summary: 'Update a service (incl. min/max price bounds)',
    tags,
    auth,
    request: { params: CatalogSchemas.idParams, body: CatalogSchemas.updateServiceBody },
    response: { schema: CatalogSchemas.adminService },
  }),
  deactivateService: defineRoute({
    method: 'delete',
    path: '/admin/services/:id',
    summary: 'Deactivate a service',
    tags,
    auth,
    request: { params: CatalogSchemas.idParams },
    response: { status: 204 },
  }),
};

/** Admin panel: service categories and services (spec §7.15 "Catalog & locations"). */
export default class AdminCatalogController implements IBaseController {
  path = '/admin';
  router = Router();

  private admin = Container.get(CatalogAdminService);

  constructor() {
    this.initializeRoutes();
  }

  initializeRoutes() {
    for (const [route, handler] of [
      [routes.listCategories, this.listCategories],
      [routes.createCategory, this.createCategory],
      [routes.updateCategory, this.updateCategory],
      [routes.deleteCategory, this.deleteCategory],
      [routes.listServices, this.listServices],
      [routes.createService, this.createService],
      [routes.updateService, this.updateService],
      [routes.deactivateService, this.deactivateService],
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

  private async listCategories(_req: Request, res: Response, next: NextFunction) {
    try {
      const categories = await this.admin.listCategories();
      return HttpResponse.ok(res, categories.map(presentAdminCategory));
    } catch (err) {
      next(err);
    }
  }

  private async createCategory(req: Request, res: Response, next: NextFunction) {
    try {
      const input = camelizeKeys(req.body) as CategoryInput;
      const category = await this.admin.createCategory(input, auditContextFrom(req));
      return HttpResponse.created(res, presentAdminCategory(category));
    } catch (err) {
      next(err);
    }
  }

  private async updateCategory(req: Request, res: Response, next: NextFunction) {
    try {
      const patch = camelizeKeys(req.body) as Partial<CategoryInput>;
      const category = await this.admin.updateCategory(req.params.id, patch, auditContextFrom(req));
      return HttpResponse.ok(res, presentAdminCategory(category));
    } catch (err) {
      next(err);
    }
  }

  private async deleteCategory(req: Request, res: Response, next: NextFunction) {
    try {
      await this.admin.deleteCategory(req.params.id, auditContextFrom(req));
      return HttpResponse.noContent(res);
    } catch (err) {
      next(err);
    }
  }

  private async listServices(req: Request, res: Response, next: NextFunction) {
    try {
      const query = req.query as z.infer<typeof CatalogSchemas.adminServicesQuery>;
      const pagination = parsePagination(req.query);
      const { data, total } = await this.admin.listServices(
        {
          categoryId: query.category_id,
          providerType: query.provider_type,
          isActive: query.is_active,
          search: query.search,
        },
        pagination,
      );
      return HttpResponse.paginated(res, data.map(presentAdminService), pagination, total);
    } catch (err) {
      next(err);
    }
  }

  private async createService(req: Request, res: Response, next: NextFunction) {
    try {
      const input = camelizeKeys(req.body) as ServiceInput;
      const service = await this.admin.createService(input, auditContextFrom(req));
      return HttpResponse.created(res, presentAdminService(service));
    } catch (err) {
      next(err);
    }
  }

  private async updateService(req: Request, res: Response, next: NextFunction) {
    try {
      const patch = camelizeKeys(req.body) as Partial<ServiceInput>;
      const service = await this.admin.updateService(req.params.id, patch, auditContextFrom(req));
      return HttpResponse.ok(res, presentAdminService(service));
    } catch (err) {
      next(err);
    }
  }

  private async deactivateService(req: Request, res: Response, next: NextFunction) {
    try {
      await this.admin.deactivateService(req.params.id, auditContextFrom(req));
      return HttpResponse.noContent(res);
    } catch (err) {
      next(err);
    }
  }
}
