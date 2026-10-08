import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { Container } from 'typedi';
import type IBaseController from '../interfaces/base-controller.interface';
import { CheckAppStatusMiddleware } from '../../middlewares/app';
import { AdminGuard, Auth } from '../../middlewares/auth';
import { ConsentSchemas } from '../../validations/consent/consent.validation';
import type { z } from '../../validations/zod';
import {
  presentAdminConsentDocument,
  presentConsentDocument,
  presentConsentStatus,
} from '../../presenters/consent.presenter';
import { defineRoute, type DefinedRoute } from '../../../docs/openapi';
import { ConsentService } from '../../../services/consent';
import { auditContextFrom } from '../../../services/audit';
import type { UserRole } from '../../../interfaces/enums';
import { resolveLanguage } from '../../../utils/i18n';
import { HttpResponse } from '../../../utils/response/http-response';

const r = {
  documents: defineRoute({
    method: 'get',
    path: '/consent-documents',
    summary:
      'The current terms, privacy and health-data consent texts (with `role`: only those that role must accept at sign-up). Empty until counsel’s wording is published.',
    tags: ['Consent'],
    auth: false,
    request: { query: ConsentSchemas.documentsQuery },
    response: { schema: ConsentSchemas.document.array() },
  }),
  myConsents: defineRoute({
    method: 'get',
    path: '/me/consents',
    summary: 'For each current text the account must accept: the version accepted and whether it is current',
    tags: ['Consent'],
    auth: true,
    response: { schema: ConsentSchemas.status.array() },
  }),
  recordConsents: defineRoute({
    method: 'post',
    path: '/me/consents',
    summary:
      'Accept (or withdraw: accepted=false) the current versions. An older version → 409 CONFLICT (show the new text). Kept as append-only evidence with the time and IP.',
    tags: ['Consent'],
    auth: true,
    request: { body: ConsentSchemas.recordBody },
    response: { schema: ConsentSchemas.status.array() },
  }),
  adminDocuments: defineRoute({
    method: 'get',
    path: '/admin/consent-documents',
    summary: 'Every published version of every consent text. Super admins only.',
    tags: ['Admin — System'],
    auth: true,
    response: { schema: ConsentSchemas.adminDocument.array() },
  }),
  publish: defineRoute({
    method: 'post',
    path: '/admin/consent-documents',
    summary:
      'Publish a new version of a consent text (never edited afterwards). From then on sign-up requires it and existing users see it as not up to date. Super admins only; audited.',
    tags: ['Admin — System'],
    auth: true,
    request: { body: ConsentSchemas.publishBody },
    response: { status: 201, schema: ConsentSchemas.adminDocument },
  }),
};

/** Consent texts and records (launch: Law 151/2020 explicit consent; wording published later). */
export default class ConsentController implements IBaseController {
  path = '/';
  router = Router();

  private consents = Container.get(ConsentService);

  constructor() {
    this.initializeRoutes();
  }

  initializeRoutes() {
    this.mount(r.documents, [], async (req, res) => {
      const q = req.query as unknown as z.infer<typeof ConsentSchemas.documentsQuery>;
      const lang = resolveLanguage(req);
      const docs = await this.consents.current(q.role as UserRole | undefined);
      return HttpResponse.ok(
        res,
        docs.map((d) => presentConsentDocument(d, lang)),
      );
    });
    this.mount(r.myConsents, Auth(), async (req, res) => {
      const rows = await this.consents.status(req.user!.id, req.user!.role);
      return HttpResponse.ok(res, presentConsentStatus(rows, resolveLanguage(req)));
    });
    this.mount(r.recordConsents, Auth(), async (req, res) => {
      const body = req.body as z.infer<typeof ConsentSchemas.recordBody>;
      await this.consents.record(req.user!.id, body.consents, req.ip ?? null);
      const rows = await this.consents.status(req.user!.id, req.user!.role);
      return HttpResponse.ok(res, presentConsentStatus(rows, resolveLanguage(req)));
    });
    this.mount(r.adminDocuments, AdminGuard, async (_req, res) =>
      HttpResponse.ok(res, (await this.consents.listDocuments()).map(presentAdminConsentDocument)),
    );
    this.mount(r.publish, AdminGuard, async (req, res) => {
      const body = req.body as z.infer<typeof ConsentSchemas.publishBody>;
      const doc = await this.consents.publish(
        {
          kind: body.kind,
          titleAr: body.title_ar,
          titleEn: body.title_en,
          bodyAr: body.body_ar,
          bodyEn: body.body_en,
          url: body.url,
          roles: body.roles,
        },
        auditContextFrom(req),
      );
      return HttpResponse.created(res, presentAdminConsentDocument(doc));
    });
  }

  private mount(
    route: DefinedRoute,
    guard: RequestHandler[],
    handler: (req: Request, res: Response) => Promise<unknown>,
  ) {
    this.router[route.method](
      route.path,
      CheckAppStatusMiddleware,
      route.validate,
      ...guard,
      (req: Request, res: Response, next: NextFunction) => {
        handler(req, res).catch(next);
      },
    );
  }
}
