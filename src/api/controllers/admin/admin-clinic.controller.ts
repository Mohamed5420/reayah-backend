import { Router, type NextFunction, type Request, type Response } from 'express';
import { Container } from 'typedi';
import type IBaseController from '../interfaces/base-controller.interface';
import { CheckAppStatusMiddleware } from '../../middlewares/app';
import { AdminGuard } from '../../middlewares/auth';
import { ClinicSchemas } from '../../validations/clinic/clinic.validation';
import type { z } from '../../validations/zod';
import { presentAdminClinic } from '../../presenters/clinic.presenter';
import { defineRoute, type DefinedRoute } from '../../../docs/openapi';
import { ClinicService } from '../../../services/clinic';
import { LocationService } from '../../../services/location';
import { auditContextFrom } from '../../../services/audit';
import { HttpResponse } from '../../../utils/response/http-response';
import { parsePagination } from '../../../utils/response/pagination';
import { resolveLanguage } from '../../../utils/i18n';

const tags = ['Admin — Verification'];
const auth = true;
const params = ClinicSchemas.idParams;

const decision = (path: string, summary: string, withMessage: boolean) =>
  defineRoute({
    method: 'post',
    path,
    summary,
    tags,
    auth,
    request: { params, ...(withMessage ? { body: ClinicSchemas.decisionBody } : {}) },
    response: { schema: ClinicSchemas.adminClinic },
  });

const r = {
  list: defineRoute({
    method: 'get',
    path: '/admin/clinics',
    summary: 'Clinics and branches by review status (oldest submitted first)',
    tags,
    auth,
    request: { query: ClinicSchemas.adminQuery },
    response: { schema: ClinicSchemas.adminClinic, paginated: true },
  }),
  get: defineRoute({
    method: 'get',
    path: '/admin/clinics/:id',
    summary: 'One clinic with its licence (10-minute link)',
    tags,
    auth,
    request: { params },
    response: { schema: ClinicSchemas.adminClinic },
  }),
  approve: decision(
    '/admin/clinics/:id/approve',
    'Approve a pending clinic (licence checked). Audited; the doctor is told.',
    false,
  ),
  requestChanges: decision(
    '/admin/clinics/:id/request-changes',
    'Ask for changes to a pending clinic, with a message. Audited; the doctor is told.',
    true,
  ),
  reject: decision(
    '/admin/clinics/:id/reject',
    'Reject a pending clinic, with a message. Audited; the doctor is told.',
    true,
  ),
};

/** Admin review of clinics and branches (clinic visits, C1; verifier role). */
export default class AdminClinicController implements IBaseController {
  path = '/admin/clinics';
  router = Router();

  private clinics = Container.get(ClinicService);
  private locations = Container.get(LocationService);

  constructor() {
    this.initializeRoutes();
  }

  initializeRoutes() {
    this.mount(r.list, async (req, res) => {
      const q = req.query as unknown as z.infer<typeof ClinicSchemas.adminQuery>;
      const pagination = parsePagination(req.query);
      const { data, total } = await this.clinics.list({ status: q.status }, pagination);
      const places = await this.locations.describeAreas(data.map((c) => String(c.areaId)));
      const lang = resolveLanguage(req);
      return HttpResponse.paginated(
        res,
        data.map((c) => presentAdminClinic(c, places, lang)),
        pagination,
        total,
      );
    });
    this.mount(r.get, async (req, res) => {
      const { clinic, licenceUrl } = await this.clinics.getForAdmin(req.params.id);
      const places = await this.locations.describeAreas([String(clinic.areaId)]);
      return HttpResponse.ok(res, presentAdminClinic(clinic, places, resolveLanguage(req), licenceUrl));
    });
    for (const [route, kind] of [
      [r.approve, 'approve'],
      [r.requestChanges, 'request_changes'],
      [r.reject, 'reject'],
    ] as const) {
      this.mount(route, async (req, res) => {
        const message = (req.body as { message?: string } | undefined)?.message ?? null;
        const clinic = await this.clinics.decide(req.params.id, kind, message, auditContextFrom(req));
        const places = await this.locations.describeAreas([String(clinic.areaId)]);
        return HttpResponse.ok(res, presentAdminClinic(clinic, places, resolveLanguage(req)));
      });
    }
  }

  private mount(route: DefinedRoute, handler: (req: Request, res: Response) => Promise<unknown>) {
    this.router[route.method](
      route.path,
      CheckAppStatusMiddleware,
      route.validate,
      ...AdminGuard,
      (req: Request, res: Response, next: NextFunction) => {
        handler(req, res).catch(next);
      },
    );
  }
}
