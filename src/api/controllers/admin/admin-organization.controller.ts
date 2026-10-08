import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { Container } from 'typedi';
import type IBaseController from '../interfaces/base-controller.interface';
import { CheckAppStatusMiddleware } from '../../middlewares/app';
import { AdminGuard } from '../../middlewares/auth';
import { OrganizationSchemas } from '../../validations/organization/organization.validation';
import { type z } from '../../validations/zod';
import { presentAdminOrgListItem } from '../../presenters/organization.presenter';
import { defineRoute, type DefinedRoute } from '../../../docs/openapi';
import { OrganizationAdminService, type OrganizationAdminPatch } from '../../../services/organization';
import { auditContextFrom } from '../../../services/audit';
import { HttpResponse } from '../../../utils/response/http-response';
import { parsePagination } from '../../../utils/response/pagination';
import { camelizeKeys } from '../../../utils/case';
import { resolveLanguage } from '../../../utils/i18n';
import { buildOrgReviewDetail } from '../organization/org-review';

const tags = ['Admin — Organizations'];
const auth = true;
const params = OrganizationSchemas.idParams;

const r = {
  list: defineRoute({
    method: 'get',
    path: '/admin/organizations',
    summary: 'Organizations, newest first',
    tags,
    auth,
    request: { query: OrganizationSchemas.adminListQuery },
    response: { schema: OrganizationSchemas.adminListItem, paginated: true },
  }),
  detail: defineRoute({
    method: 'get',
    path: '/admin/organizations/:id',
    summary: 'Organization details: info, owner, documents, areas with team size, services, commission rate',
    tags,
    auth,
    request: { params },
    response: { schema: OrganizationSchemas.reviewDetail },
  }),
  update: defineRoute({
    method: 'patch',
    path: '/admin/organizations/:id',
    summary: 'Edit an organization / set a custom commission rate (null = platform rate). Audited.',
    tags,
    auth,
    request: { params, body: OrganizationSchemas.adminUpdateBody },
    response: { schema: OrganizationSchemas.reviewDetail },
  }),
};

/** Admin panel: organizations (spec §7.15 "Users, providers, organizations"). */
export default class AdminOrganizationController implements IBaseController {
  path = '/admin';
  router = Router();

  private admin = Container.get(OrganizationAdminService);

  constructor() {
    this.initializeRoutes();
  }

  initializeRoutes() {
    this.mount(r.list, async (req, res) => {
      const q = req.query as unknown as z.infer<typeof OrganizationSchemas.adminListQuery>;
      const pagination = parsePagination(req.query);
      const { data, total } = await this.admin.list({ status: q.status, search: q.search }, pagination);
      return HttpResponse.paginated(res, data.map(presentAdminOrgListItem), pagination, total);
    });
    this.mount(r.detail, async (req, res) =>
      HttpResponse.ok(res, await buildOrgReviewDetail(req.params.id, resolveLanguage(req))),
    );
    this.mount(r.update, async (req, res) => {
      await this.admin.update(
        req.params.id,
        camelizeKeys(req.body) as OrganizationAdminPatch,
        auditContextFrom(req),
      );
      return HttpResponse.ok(res, await buildOrgReviewDetail(req.params.id, resolveLanguage(req)));
    });
  }

  private mount(route: DefinedRoute, handler: (req: Request, res: Response) => Promise<unknown>) {
    this.router[route.method](
      route.path,
      CheckAppStatusMiddleware,
      route.validate,
      ...AdminGuard,
      this.handle(handler),
    );
  }

  private handle(handler: (req: Request, res: Response) => Promise<unknown>): RequestHandler {
    // Express 4 doesn't forward rejected promises itself.
    return (req: Request, res: Response, next: NextFunction) => {
      handler(req, res).catch(next);
    };
  }
}
