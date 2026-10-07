import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { Container } from 'typedi';
import type IBaseController from '../interfaces/base-controller.interface';
import { CheckAppStatusMiddleware } from '../../middlewares/app';
import { AdminGuard } from '../../middlewares/auth';
import { ProviderSchemas } from '../../validations/provider/provider.validation';
import { parseDateOnly } from '../../validations/auth/auth.validation';
import { type z } from '../../validations/zod';
import {
  presentProviderDocument,
  presentQueueItem,
  presentReviewDetail,
} from '../../presenters/provider.presenter';
import { defineRoute, type DefinedRoute } from '../../../docs/openapi';
import {
  ProviderCoverageService,
  ProviderDocumentService,
  VerificationService,
} from '../../../services/provider';
import { LocationService } from '../../../services/location';
import { auditContextFrom } from '../../../services/audit';
import { HttpResponse } from '../../../utils/response/http-response';
import { parsePagination } from '../../../utils/response/pagination';
import { resolveLanguage } from '../../../utils/i18n';

const tags = ['Admin — Verification'];
const auth = true;
const review = ProviderSchemas.idParams;

const r = {
  queue: defineRoute({
    method: 'get',
    path: '/admin/verifications',
    summary: 'Verification queue, oldest submission first (organizations: Phase 3)',
    tags,
    auth,
    request: { query: ProviderSchemas.queueQuery },
    response: { schema: ProviderSchemas.queueItem, paginated: true },
  }),
  detail: defineRoute({
    method: 'get',
    path: '/admin/verifications/:id',
    summary: 'Full submission with signed document URLs, coverage, services and checklist',
    tags,
    auth,
    request: { params: review },
    response: { schema: ProviderSchemas.reviewDetail },
  }),
  approve: defineRoute({
    method: 'post',
    path: '/admin/verifications/:id/approve',
    summary: 'Approve (pending documents are accepted with it; 409 while any document is "not matching")',
    tags,
    auth,
    request: { params: review },
    response: { schema: ProviderSchemas.reviewDetail },
  }),
  requestChanges: defineRoute({
    method: 'post',
    path: '/admin/verifications/:id/request-changes',
    summary: 'Send back for changes; the listed documents must be re-uploaded',
    tags,
    auth,
    request: { params: review, body: ProviderSchemas.requestChangesBody },
    response: { schema: ProviderSchemas.reviewDetail },
  }),
  reject: defineRoute({
    method: 'post',
    path: '/admin/verifications/:id/reject',
    summary: 'Reject (the provider can fix and resubmit)',
    tags,
    auth,
    request: { params: review, body: ProviderSchemas.rejectBody },
    response: { schema: ProviderSchemas.reviewDetail },
  }),
  reviewDocument: defineRoute({
    method: 'post',
    path: '/admin/documents/:id/review',
    summary: 'Mark one document matching / not matching, optionally setting its expiry',
    tags,
    auth,
    request: { params: review, body: ProviderSchemas.documentReviewBody },
    response: { schema: ProviderSchemas.document },
  }),
};

/** Admin panel: provider verification (spec §7.15 "Verification"). Every decision is audited. */
export default class AdminVerificationController implements IBaseController {
  path = '/admin';
  router = Router();

  private verification = Container.get(VerificationService);
  private documents = Container.get(ProviderDocumentService);
  private coverage = Container.get(ProviderCoverageService);
  private locations = Container.get(LocationService);

  constructor() {
    this.initializeRoutes();
  }

  initializeRoutes() {
    this.mount(r.queue, this.queue);
    this.mount(r.detail, this.detail);
    this.mount(r.approve, this.approve);
    this.mount(r.requestChanges, this.requestChanges);
    this.mount(r.reject, this.reject);
    this.mount(r.reviewDocument, this.reviewDocument);
  }

  private mount(route: DefinedRoute, handler: RequestHandler) {
    this.router[route.method](
      route.path,
      CheckAppStatusMiddleware,
      route.validate,
      ...AdminGuard,
      handler.bind(this),
    );
  }

  private async queue(req: Request, res: Response, next: NextFunction) {
    try {
      const query = req.query as unknown as z.infer<typeof ProviderSchemas.queueQuery>;
      const pagination = parsePagination(req.query);
      const { data, total } = await this.verification.queue(
        { type: query.type, status: query.status },
        pagination,
      );
      return HttpResponse.paginated(
        res,
        data.map((row) => presentQueueItem(row.profile, row.user, row.documentsCount)),
        pagination,
        total,
      );
    } catch (err) {
      next(err);
    }
  }

  private async detail(req: Request, res: Response, next: NextFunction) {
    try {
      return HttpResponse.ok(res, await this.reviewDetail(req));
    } catch (err) {
      next(err);
    }
  }

  private async approve(req: Request, res: Response, next: NextFunction) {
    try {
      await this.verification.approve(req.params.id, auditContextFrom(req));
      return HttpResponse.ok(res, await this.reviewDetail(req));
    } catch (err) {
      next(err);
    }
  }

  private async requestChanges(req: Request, res: Response, next: NextFunction) {
    try {
      const body = req.body as z.infer<typeof ProviderSchemas.requestChangesBody>;
      await this.verification.requestChanges(req.params.id, body, auditContextFrom(req));
      return HttpResponse.ok(res, await this.reviewDetail(req));
    } catch (err) {
      next(err);
    }
  }

  private async reject(req: Request, res: Response, next: NextFunction) {
    try {
      const body = req.body as z.infer<typeof ProviderSchemas.rejectBody>;
      await this.verification.reject(req.params.id, body, auditContextFrom(req));
      return HttpResponse.ok(res, await this.reviewDetail(req));
    } catch (err) {
      next(err);
    }
  }

  private async reviewDocument(req: Request, res: Response, next: NextFunction) {
    try {
      const body = req.body as z.infer<typeof ProviderSchemas.documentReviewBody>;
      const document = await this.verification.reviewDocument(
        req.params.id,
        {
          status: body.status,
          note: body.note,
          // undefined = leave the expiry as is; null = clear it.
          expiresAt:
            body.expires_at === undefined
              ? undefined
              : body.expires_at
                ? parseDateOnly(body.expires_at)
                : null,
        },
        auditContextFrom(req),
      );
      const [{ fileUrl }] = await this.documents.withUrls([document]);
      return HttpResponse.ok(res, presentProviderDocument(document, fileUrl));
    } catch (err) {
      next(err);
    }
  }

  private async reviewDetail(req: Request) {
    const { profile, user, checklist } = await this.verification.getForReview(req.params.id);
    const [documents, places, catalog] = await Promise.all([
      this.documents.list(profile._id),
      this.locations.describeAreas(profile.serviceAreas.map((a) => String(a.areaId))),
      this.coverage.describeServices(profile),
    ]);
    return presentReviewDetail({
      profile,
      user,
      checklist,
      documents,
      places,
      catalog,
      lang: resolveLanguage(req),
    });
  }
}
