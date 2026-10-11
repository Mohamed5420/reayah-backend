import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { Container } from 'typedi';
import type IBaseController from '../interfaces/base-controller.interface';
import { CheckAppStatusMiddleware } from '../../middlewares/app';
import { AdminGuard } from '../../middlewares/auth';
import { ProviderSchemas } from '../../validations/provider/provider.validation';
import { parseDateOnly } from '../../validations/auth/auth.validation';
import { z } from '../../validations/zod';
import { OrganizationSchemas } from '../../validations/organization/organization.validation';
import { presentOrgDocument, presentOrgQueueItem } from '../../presenters/organization.presenter';
import { OrganizationAdminService } from '../../../services/organization';
import { OrganizationDocumentType } from '../../../interfaces/IOrganization';
import { ProviderDocumentType } from '../../../interfaces/IProvider';
import { buildOrgReviewDetail } from '../organization/org-review';
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

/** The queue serves providers and organizations; ids tell them apart. */
const reviewDetail = z.union([ProviderSchemas.reviewDetail, OrganizationSchemas.reviewDetail]);
const documentTypes = z.enum([
  ...Object.values(ProviderDocumentType),
  ...Object.values(OrganizationDocumentType),
]);
const requestChangesBody = z.object({
  message: z.string().trim().min(1).max(1000),
  /** Provider or organization document types, depending on the submission. */
  documents: z.array(documentTypes).default([]),
});
const rejectBody = z.object({
  reason: z.string().trim().min(1).max(1000),
  documents: z.array(documentTypes).default([]),
});

const r = {
  queue: defineRoute({
    method: 'get',
    path: '/admin/verifications',
    summary: 'Verification queue (providers or organizations), oldest submission first',
    tags,
    auth,
    request: { query: ProviderSchemas.queueQuery },
    response: {
      schema: z.union([ProviderSchemas.queueItem, OrganizationSchemas.queueItem]),
      paginated: true,
    },
  }),
  detail: defineRoute({
    method: 'get',
    path: '/admin/verifications/:id',
    summary:
      'Full submission (provider or organization) with signed document URLs, coverage, services and checklist',
    tags,
    auth,
    request: { params: review },
    response: { schema: reviewDetail },
  }),
  approve: defineRoute({
    method: 'post',
    path: '/admin/verifications/:id/approve',
    summary: 'Approve (pending documents are accepted with it; 409 while any document is "not matching")',
    tags,
    auth,
    request: { params: review },
    response: { schema: reviewDetail },
  }),
  requestChanges: defineRoute({
    method: 'post',
    path: '/admin/verifications/:id/request-changes',
    summary: 'Send back for changes; the listed documents must be re-uploaded',
    tags,
    auth,
    request: { params: review, body: requestChangesBody },
    response: { schema: reviewDetail },
  }),
  reject: defineRoute({
    method: 'post',
    path: '/admin/verifications/:id/reject',
    summary: 'Reject (the provider / organization can fix and resubmit)',
    tags,
    auth,
    request: { params: review, body: rejectBody },
    response: { schema: reviewDetail },
  }),
  reviewDocument: defineRoute({
    method: 'post',
    path: '/admin/documents/:id/review',
    summary: 'Mark one document matching / not matching, optionally setting its expiry',
    tags,
    auth,
    request: { params: review, body: ProviderSchemas.documentReviewBody },
    response: { schema: z.union([ProviderSchemas.document, OrganizationSchemas.document]) },
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
  private organizations = Container.get(OrganizationAdminService);

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
      if (query.type === 'organization') {
        const orgs = await this.organizations.queue(query.status, pagination);
        return HttpResponse.paginated(res, orgs.data.map(presentOrgQueueItem), pagination, orgs.total);
      }
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
      if (await this.organizations.isOrganization(req.params.id)) {
        await this.organizations.approve(req.params.id, auditContextFrom(req));
      } else {
        await this.verification.approve(req.params.id, auditContextFrom(req));
      }
      return HttpResponse.ok(res, await this.reviewDetail(req));
    } catch (err) {
      next(err);
    }
  }

  private async requestChanges(req: Request, res: Response, next: NextFunction) {
    try {
      const body = req.body as z.infer<typeof requestChangesBody>;
      if (await this.organizations.isOrganization(req.params.id)) {
        await this.organizations.requestChanges(
          req.params.id,
          { message: body.message, documents: orgDocuments(body.documents) },
          auditContextFrom(req),
        );
      } else {
        await this.verification.requestChanges(
          req.params.id,
          { message: body.message, documents: providerDocuments(body.documents) },
          auditContextFrom(req),
        );
      }
      return HttpResponse.ok(res, await this.reviewDetail(req));
    } catch (err) {
      next(err);
    }
  }

  private async reject(req: Request, res: Response, next: NextFunction) {
    try {
      const body = req.body as z.infer<typeof rejectBody>;
      if (await this.organizations.isOrganization(req.params.id)) {
        await this.organizations.reject(
          req.params.id,
          { reason: body.reason, documents: orgDocuments(body.documents) },
          auditContextFrom(req),
        );
      } else {
        await this.verification.reject(
          req.params.id,
          { reason: body.reason, documents: providerDocuments(body.documents) },
          auditContextFrom(req),
        );
      }
      return HttpResponse.ok(res, await this.reviewDetail(req));
    } catch (err) {
      next(err);
    }
  }

  private async reviewDocument(req: Request, res: Response, next: NextFunction) {
    try {
      const body = req.body as z.infer<typeof ProviderSchemas.documentReviewBody>;
      const input = {
        status: body.status,
        note: body.note,
        // undefined = leave the expiry as is; null = clear it.
        expiresAt:
          body.expires_at === undefined ? undefined : body.expires_at ? parseDateOnly(body.expires_at) : null,
      };
      const orgDocument = await this.organizations.reviewDocument(
        req.params.id,
        input,
        auditContextFrom(req),
      );
      if (orgDocument) {
        const [{ fileUrl, backFileUrl }] = await this.documents.withUrls([orgDocument]);
        return HttpResponse.ok(res, presentOrgDocument(orgDocument, fileUrl, backFileUrl));
      }
      const document = await this.verification.reviewDocument(req.params.id, input, auditContextFrom(req));
      const [{ fileUrl, backFileUrl }] = await this.documents.withUrls([document]);
      return HttpResponse.ok(res, presentProviderDocument(document, fileUrl, backFileUrl));
    } catch (err) {
      next(err);
    }
  }

  private async reviewDetail(req: Request) {
    if (await this.organizations.isOrganization(req.params.id)) {
      return buildOrgReviewDetail(req.params.id, resolveLanguage(req));
    }
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

const PROVIDER_DOCUMENT_TYPES: string[] = Object.values(ProviderDocumentType);
const providerDocuments = (types: string[]) =>
  types.filter((t): t is ProviderDocumentType => PROVIDER_DOCUMENT_TYPES.includes(t));
const ORGANIZATION_DOCUMENT_TYPES: string[] = Object.values(OrganizationDocumentType);
const orgDocuments = (types: string[]) =>
  types.filter((t): t is OrganizationDocumentType => ORGANIZATION_DOCUMENT_TYPES.includes(t));
