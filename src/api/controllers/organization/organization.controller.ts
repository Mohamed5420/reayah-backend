import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { Container } from 'typedi';
import type IBaseController from '../interfaces/base-controller.interface';
import { CheckAppStatusMiddleware, UploadMiddleware } from '../../middlewares/app';
import { Auth } from '../../middlewares/auth';
import { OrganizationSchemas } from '../../validations/organization/organization.validation';
import { parseDateOnly } from '../../validations/auth/auth.validation';
import { z } from '../../validations/zod';
import {
  presentOrgDocument,
  presentOrgServiceAreas,
  presentOrgServices,
  presentOrganization,
} from '../../presenters/organization.presenter';
import { defineRoute, type DefinedRoute } from '../../../docs/openapi';
import {
  OrganizationDocumentService,
  OrganizationService,
  type OrganizationDoc,
  type OrganizationInput,
} from '../../../services/organization';
import { ProviderCoverageService } from '../../../services/provider';
import { LocationService } from '../../../services/location';
import { UserRole } from '../../../interfaces/enums';
import { IMAGE_MIMES } from '../../../utils/file-type';
import { HttpResponse } from '../../../utils/response/http-response';
import { camelizeKeys } from '../../../utils/case';
import { resolveLanguage } from '../../../utils/i18n';

const tags = ['Owner — Organization'];
const auth = true;

const r = {
  create: defineRoute({
    method: 'post',
    path: '/org',
    summary: 'Create my organization (owners, once). It starts as a draft until submitted for verification.',
    tags,
    auth,
    request: { body: OrganizationSchemas.createBody },
    response: { status: 201, schema: OrganizationSchemas.organization },
  }),
  get: defineRoute({
    method: 'get',
    path: '/org',
    summary: 'My organization, with its verification status and onboarding checklist',
    tags,
    auth,
    response: { schema: OrganizationSchemas.organization },
  }),
  update: defineRoute({
    method: 'patch',
    path: '/org',
    summary:
      'Update my organization. Name, type, commercial register and tax id are locked once submitted (until changes are requested or it is rejected).',
    tags,
    auth,
    request: { body: OrganizationSchemas.updateBody },
    response: { schema: OrganizationSchemas.organization },
  }),
  logo: defineRoute({
    method: 'post',
    path: '/org/logo',
    summary: 'Upload the organization logo (JPG or PNG, max 10 MB); replaces the previous one',
    tags,
    auth,
    upload: { field: 'file' },
    response: { schema: OrganizationSchemas.organization },
  }),
  documents: defineRoute({
    method: 'get',
    path: '/org/documents',
    summary: 'Commercial register and tax card, with review status',
    tags,
    auth,
    response: { schema: z.array(OrganizationSchemas.document) },
  }),
  attachDocument: defineRoute({
    method: 'post',
    path: '/org/documents',
    summary:
      'Attach a commercial register / tax card uploaded with purpose `org_document` (replaces that type)',
    tags,
    auth,
    request: { body: OrganizationSchemas.attachDocumentBody },
    response: { status: 201, schema: OrganizationSchemas.document },
  }),
  removeDocument: defineRoute({
    method: 'delete',
    path: '/org/documents/:id',
    summary: 'Remove a document (not once the admin accepted it)',
    tags,
    auth,
    request: { params: OrganizationSchemas.idParams },
    response: { status: 204 },
  }),
  submit: defineRoute({
    method: 'post',
    path: '/org/submit-verification',
    summary: 'Submit for admin review (422 names each missing item: info, documents, areas, services)',
    tags,
    auth,
    response: { schema: OrganizationSchemas.organization },
  }),
  serviceAreas: defineRoute({
    method: 'get',
    path: '/org/service-areas',
    summary: 'Areas served, travel fee per area and team size per area (approved staff covering it)',
    tags,
    auth,
    response: { schema: z.array(OrganizationSchemas.serviceArea) },
  }),
  putServiceAreas: defineRoute({
    method: 'put',
    path: '/org/service-areas',
    summary: "Replace the areas served. Travel fee can't exceed the area's cap; every bad entry is reported.",
    tags,
    auth,
    request: { body: OrganizationSchemas.serviceAreasBody },
    response: { schema: z.array(OrganizationSchemas.serviceArea) },
  }),
  services: defineRoute({
    method: 'get',
    path: '/org/services',
    summary: 'Services the organization offers, with its prices',
    tags,
    auth,
    response: { schema: z.array(OrganizationSchemas.service) },
  }),
  putServices: defineRoute({
    method: 'put',
    path: '/org/services',
    summary: 'Replace services & prices (within the admin min / max per service)',
    tags,
    auth,
    request: { body: OrganizationSchemas.servicesBody },
    response: { schema: z.array(OrganizationSchemas.service) },
  }),
};

/** Owner — organization setup (spec §7.11 "Organization setup", M3.1). Role: owner. */
export default class OrganizationController implements IBaseController {
  path = '/org';
  router = Router();

  private organizations = Container.get(OrganizationService);
  private documents = Container.get(OrganizationDocumentService);
  private coverage = Container.get(ProviderCoverageService);
  private locations = Container.get(LocationService);

  constructor() {
    this.initializeRoutes();
  }

  initializeRoutes() {
    const owner = (req: Request) => req.user!.id;

    this.mount(r.create, async (req, res) => {
      const org = await this.organizations.create(owner(req), camelizeKeys(req.body) as OrganizationInput);
      return HttpResponse.created(res, await this.view(org));
    });
    this.mount(r.get, async (req, res) =>
      HttpResponse.ok(res, await this.view(await this.organizations.getOwn(owner(req)))),
    );
    this.mount(r.update, async (req, res) => {
      const org = await this.organizations.update(
        owner(req),
        camelizeKeys(req.body) as Partial<OrganizationInput>,
      );
      return HttpResponse.ok(res, await this.view(org));
    });
    this.router.post(
      r.logo.path,
      CheckAppStatusMiddleware,
      ...Auth(UserRole.OWNER),
      UploadMiddleware('file', IMAGE_MIMES),
      this.handle(async (req, res) =>
        HttpResponse.ok(res, await this.view(await this.organizations.setLogo(owner(req), req.file!))),
      ),
    );

    this.mount(r.documents, async (req, res) => {
      const org = await this.organizations.getOwn(owner(req));
      const documents = await this.documents.list(org._id);
      return HttpResponse.ok(
        res,
        documents.map(({ document, fileUrl }) => presentOrgDocument(document, fileUrl)),
      );
    });
    this.mount(r.attachDocument, async (req, res) => {
      const body = req.body as z.infer<typeof OrganizationSchemas.attachDocumentBody>;
      const org = await this.organizations.getOwn(owner(req));
      const { document, fileUrl } = await this.documents.attach(owner(req), org._id, {
        type: body.type,
        fileKey: body.file_key,
        expiresAt: body.expires_at ? parseDateOnly(body.expires_at) : null,
      });
      return HttpResponse.created(res, presentOrgDocument(document, fileUrl));
    });
    this.mount(r.removeDocument, async (req, res) => {
      const org = await this.organizations.getOwn(owner(req));
      await this.documents.remove(org._id, req.params.id);
      return HttpResponse.noContent(res);
    });
    this.mount(r.submit, async (req, res) =>
      HttpResponse.ok(res, await this.view(await this.organizations.submit(owner(req)))),
    );

    this.mount(r.serviceAreas, async (req, res) =>
      HttpResponse.ok(res, await this.areas(await this.organizations.getOwn(owner(req)), req)),
    );
    this.mount(r.putServiceAreas, async (req, res) => {
      const body = req.body as z.infer<typeof OrganizationSchemas.serviceAreasBody>;
      const org = await this.organizations.replaceServiceAreas(
        await this.organizations.getOwn(owner(req)),
        body.areas.map((a) => ({ areaId: a.area_id, travelFee: a.travel_fee, isActive: a.is_active })),
      );
      return HttpResponse.ok(res, await this.areas(org, req));
    });
    this.mount(r.services, async (req, res) =>
      HttpResponse.ok(res, await this.services(await this.organizations.getOwn(owner(req)), req)),
    );
    this.mount(r.putServices, async (req, res) => {
      const body = req.body as z.infer<typeof OrganizationSchemas.servicesBody>;
      const org = await this.organizations.replaceServices(
        await this.organizations.getOwn(owner(req)),
        body.services.map((s) => ({ serviceId: s.service_id, price: s.price, isActive: s.is_active })),
      );
      return HttpResponse.ok(res, await this.services(org, req));
    });
  }

  private async view(org: OrganizationDoc) {
    const [logoUrl, checklist] = await Promise.all([
      this.organizations.logoUrl(org),
      this.organizations.checklist(org),
    ]);
    return presentOrganization(org, logoUrl, checklist);
  }

  private async areas(org: OrganizationDoc, req: Request) {
    const [places, teamSizes] = await Promise.all([
      this.locations.describeAreas(org.serviceAreas.map((a) => String(a.areaId))),
      this.organizations.teamSizes(org),
    ]);
    return presentOrgServiceAreas(org, places, teamSizes, resolveLanguage(req));
  }

  private async services(org: OrganizationDoc, req: Request) {
    return presentOrgServices(org, await this.coverage.describeServices(org), resolveLanguage(req));
  }

  private mount(route: DefinedRoute, handler: (req: Request, res: Response) => Promise<unknown>) {
    this.router[route.method](
      route.path,
      CheckAppStatusMiddleware,
      route.validate,
      ...Auth(UserRole.OWNER),
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
