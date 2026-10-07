import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { Container } from 'typedi';
import type IBaseController from '../interfaces/base-controller.interface';
import { CheckAppStatusMiddleware } from '../../middlewares/app';
import { Auth } from '../../middlewares/auth';
import { ProviderSchemas } from '../../validations/provider/provider.validation';
import { parseDateOnly } from '../../validations/auth/auth.validation';
import { z } from '../../validations/zod';
import {
  presentAvailability,
  presentProviderDocument,
  presentProviderProfile,
  presentProviderServices,
  presentServiceAreas,
  presentTimeOff,
  presentVerificationStatus,
} from '../../presenters/provider.presenter';
import { defineRoute, type DefinedRoute } from '../../../docs/openapi';
import {
  ProviderCoverageService,
  ProviderDocumentService,
  ProviderProfileService,
  VerificationService,
  type ProviderProfileInput,
} from '../../../services/provider';
import { LocationService } from '../../../services/location';
import { UserRole } from '../../../interfaces/enums';
import type { IProviderProfile } from '../../../interfaces/IProfiles';
import { HttpResponse } from '../../../utils/response/http-response';
import { camelizeKeys } from '../../../utils/case';
import { resolveLanguage } from '../../../utils/i18n';

const tags = ['Provider'];
const auth = true;

const r = {
  getProfile: defineRoute({
    method: 'get',
    path: '/provider/profile',
    summary: 'My provider profile + onboarding checklist',
    tags,
    auth,
    response: { schema: ProviderSchemas.providerProfile },
  }),
  updateProfile: defineRoute({
    method: 'patch',
    path: '/provider/profile',
    summary:
      'Update profile. Type / license / syndicate number are locked while under review or once approved.',
    tags,
    auth,
    request: { body: ProviderSchemas.updateProfileBody },
    response: { schema: ProviderSchemas.providerProfile },
  }),
  listDocuments: defineRoute({
    method: 'get',
    path: '/provider/documents',
    summary: 'My verification documents + review status',
    tags,
    auth,
    response: { schema: z.array(ProviderSchemas.document) },
  }),
  attachDocument: defineRoute({
    method: 'post',
    path: '/provider/documents',
    summary:
      'Attach a file uploaded via POST /uploads (purpose: provider_document). Replaces the previous one of a required type.',
    tags,
    auth,
    request: { body: ProviderSchemas.attachDocumentBody },
    response: { status: 201, schema: ProviderSchemas.document },
  }),
  removeDocument: defineRoute({
    method: 'delete',
    path: '/provider/documents/:id',
    summary: 'Remove a document (not one the admin approved)',
    tags,
    auth,
    request: { params: ProviderSchemas.idParams },
    response: { status: 204 },
  }),
  submit: defineRoute({
    method: 'post',
    path: '/provider/submit-verification',
    summary:
      'Submit for admin review (draft / changes_requested / rejected → pending). 422 lists missing onboarding items.',
    tags,
    auth,
    response: { schema: ProviderSchemas.verificationStatus },
  }),
  verificationStatus: defineRoute({
    method: 'get',
    path: '/provider/verification-status',
    summary: 'Verification status, admin message / rejection reason, per-document results',
    tags,
    auth,
    response: { schema: ProviderSchemas.verificationStatus },
  }),
  getAreas: defineRoute({
    method: 'get',
    path: '/provider/service-areas',
    summary: 'Areas I cover, with travel fees',
    tags,
    auth,
    response: { schema: z.array(ProviderSchemas.serviceArea) },
  }),
  putAreas: defineRoute({
    method: 'put',
    path: '/provider/service-areas',
    summary: 'Replace covered areas (chosen from GET /areas — no map or radius). Independent providers only.',
    tags,
    auth,
    request: { body: ProviderSchemas.serviceAreasBody },
    response: { schema: z.array(ProviderSchemas.serviceArea) },
  }),
  getServices: defineRoute({
    method: 'get',
    path: '/provider/services',
    summary: 'My services and prices',
    tags,
    auth,
    response: { schema: z.array(ProviderSchemas.providerService) },
  }),
  putServices: defineRoute({
    method: 'put',
    path: '/provider/services',
    summary: 'Replace services and prices (piastres, within admin bounds). Independent providers only.',
    tags,
    auth,
    request: { body: ProviderSchemas.servicesBody },
    response: { schema: z.array(ProviderSchemas.providerService) },
  }),
  getAvailability: defineRoute({
    method: 'get',
    path: '/provider/availability',
    summary: 'Weekly schedule (Africa/Cairo local time)',
    tags,
    auth,
    response: { schema: ProviderSchemas.availability },
  }),
  putAvailability: defineRoute({
    method: 'put',
    path: '/provider/availability',
    summary: 'Replace the weekly schedule (no overlapping slots per day; split overnight shifts across days)',
    tags,
    auth,
    request: { body: ProviderSchemas.availabilityBody },
    response: { schema: ProviderSchemas.availability },
  }),
  listTimeOff: defineRoute({
    method: 'get',
    path: '/provider/time-off',
    summary: 'Current and upcoming time off',
    tags,
    auth,
    response: { schema: z.array(ProviderSchemas.timeOff) },
  }),
  addTimeOff: defineRoute({
    method: 'post',
    path: '/provider/time-off',
    summary: 'Add time off',
    tags,
    auth,
    request: { body: ProviderSchemas.timeOffBody },
    response: { status: 201, schema: ProviderSchemas.timeOff },
  }),
  removeTimeOff: defineRoute({
    method: 'delete',
    path: '/provider/time-off/:id',
    summary: 'Remove time off',
    tags,
    auth,
    request: { params: ProviderSchemas.idParams },
    response: { status: 204 },
  }),
  accepting: defineRoute({
    method: 'patch',
    path: '/provider/accepting',
    summary: 'Toggle accepting bookings (403 PROVIDER_NOT_VERIFIED unless approved)',
    tags,
    auth,
    request: { body: ProviderSchemas.acceptingBody },
    response: { schema: ProviderSchemas.providerProfile },
  }),
};

const PROVIDER_ROLES = [UserRole.PROVIDER, UserRole.PROVIDER_STAFF];

/**
 * Provider onboarding, coverage and schedule (spec §7.10). Staff of an organization share these routes,
 * except areas and prices, which their organization manages.
 */
export default class ProviderController implements IBaseController {
  path = '/provider';
  router = Router();

  private profiles = Container.get(ProviderProfileService);
  private coverage = Container.get(ProviderCoverageService);
  private documents = Container.get(ProviderDocumentService);
  private verification = Container.get(VerificationService);
  private locations = Container.get(LocationService);

  constructor() {
    this.initializeRoutes();
  }

  initializeRoutes() {
    this.mount(r.getProfile, this.getProfile);
    this.mount(r.updateProfile, this.updateProfile);
    this.mount(r.listDocuments, this.listDocuments);
    this.mount(r.attachDocument, this.attachDocument);
    this.mount(r.removeDocument, this.removeDocument);
    this.mount(r.submit, this.submit);
    this.mount(r.verificationStatus, this.verificationStatus);
    this.mount(r.getAreas, this.getAreas);
    this.mount(r.putAreas, this.putAreas, [UserRole.PROVIDER]);
    this.mount(r.getServices, this.getServices);
    this.mount(r.putServices, this.putServices, [UserRole.PROVIDER]);
    this.mount(r.getAvailability, this.getAvailability);
    this.mount(r.putAvailability, this.putAvailability);
    this.mount(r.listTimeOff, this.listTimeOff);
    this.mount(r.addTimeOff, this.addTimeOff);
    this.mount(r.removeTimeOff, this.removeTimeOff);
    this.mount(r.accepting, this.accepting);
  }

  private mount(route: DefinedRoute, handler: RequestHandler, roles: UserRole[] = PROVIDER_ROLES) {
    this.router[route.method](
      route.path,
      CheckAppStatusMiddleware,
      route.validate,
      ...Auth(...roles),
      handler.bind(this),
    );
  }

  // ── Profile & verification ──

  private async getProfile(req: Request, res: Response, next: NextFunction) {
    try {
      const profile = await this.profiles.getOwn(req.user!.id);
      return HttpResponse.ok(res, presentProviderProfile(profile, await this.profiles.checklist(profile)));
    } catch (err) {
      next(err);
    }
  }

  private async updateProfile(req: Request, res: Response, next: NextFunction) {
    try {
      const profile = await this.profiles.update(
        req.user!.id,
        camelizeKeys(req.body) as ProviderProfileInput,
      );
      return HttpResponse.ok(res, presentProviderProfile(profile, await this.profiles.checklist(profile)));
    } catch (err) {
      next(err);
    }
  }

  private async listDocuments(req: Request, res: Response, next: NextFunction) {
    try {
      const profile = await this.profiles.getOwn(req.user!.id);
      const documents = await this.documents.list(profile._id);
      return HttpResponse.ok(
        res,
        documents.map(({ document, fileUrl }) => presentProviderDocument(document, fileUrl)),
      );
    } catch (err) {
      next(err);
    }
  }

  private async attachDocument(req: Request, res: Response, next: NextFunction) {
    try {
      const body = req.body as z.infer<typeof ProviderSchemas.attachDocumentBody>;
      const profile = await this.profiles.getOwn(req.user!.id);
      const { document, fileUrl } = await this.documents.attach(req.user!.id, profile._id, {
        type: body.type,
        fileKey: body.file_key,
        expiresAt: body.expires_at ? parseDateOnly(body.expires_at) : null,
      });
      return HttpResponse.created(res, presentProviderDocument(document, fileUrl));
    } catch (err) {
      next(err);
    }
  }

  private async removeDocument(req: Request, res: Response, next: NextFunction) {
    try {
      const profile = await this.profiles.getOwn(req.user!.id);
      await this.documents.remove(profile._id, req.params.id);
      return HttpResponse.noContent(res);
    } catch (err) {
      next(err);
    }
  }

  private async submit(req: Request, res: Response, next: NextFunction) {
    try {
      const profile = await this.verification.submit(req.user!.id);
      return HttpResponse.ok(res, await this.statusOf(profile));
    } catch (err) {
      next(err);
    }
  }

  private async verificationStatus(req: Request, res: Response, next: NextFunction) {
    try {
      return HttpResponse.ok(res, await this.statusOf(await this.profiles.getOwn(req.user!.id)));
    } catch (err) {
      next(err);
    }
  }

  private async statusOf(profile: IProviderProfile) {
    const documents = await this.documents.list(profile._id);
    return presentVerificationStatus(
      profile,
      documents.map((d) => d.document),
    );
  }

  // ── Coverage & schedule ──

  private async getAreas(req: Request, res: Response, next: NextFunction) {
    try {
      return HttpResponse.ok(res, await this.areasOf(await this.profiles.getOwn(req.user!.id), req));
    } catch (err) {
      next(err);
    }
  }

  private async putAreas(req: Request, res: Response, next: NextFunction) {
    try {
      const body = req.body as z.infer<typeof ProviderSchemas.serviceAreasBody>;
      const profile = await this.coverage.replaceServiceAreas(
        await this.profiles.getOwn(req.user!.id),
        body.areas.map((a) => ({ areaId: a.area_id, travelFee: a.travel_fee })),
      );
      return HttpResponse.ok(res, await this.areasOf(profile, req));
    } catch (err) {
      next(err);
    }
  }

  private async areasOf(profile: IProviderProfile, req: Request) {
    const places = await this.locations.describeAreas(profile.serviceAreas.map((a) => String(a.areaId)));
    return presentServiceAreas(profile, places, resolveLanguage(req));
  }

  private async getServices(req: Request, res: Response, next: NextFunction) {
    try {
      return HttpResponse.ok(res, await this.servicesOf(await this.profiles.getOwn(req.user!.id), req));
    } catch (err) {
      next(err);
    }
  }

  private async putServices(req: Request, res: Response, next: NextFunction) {
    try {
      const body = req.body as z.infer<typeof ProviderSchemas.servicesBody>;
      const profile = await this.coverage.replaceServices(
        await this.profiles.getOwn(req.user!.id),
        body.services.map((s) => ({ serviceId: s.service_id, price: s.price, isActive: s.is_active })),
      );
      return HttpResponse.ok(res, await this.servicesOf(profile, req));
    } catch (err) {
      next(err);
    }
  }

  private async servicesOf(profile: IProviderProfile, req: Request) {
    return presentProviderServices(
      profile,
      await this.coverage.describeServices(profile),
      resolveLanguage(req),
    );
  }

  private async getAvailability(req: Request, res: Response, next: NextFunction) {
    try {
      const profile = await this.profiles.getOwn(req.user!.id);
      return HttpResponse.ok(res, { slots: presentAvailability(profile.availability) });
    } catch (err) {
      next(err);
    }
  }

  private async putAvailability(req: Request, res: Response, next: NextFunction) {
    try {
      const body = req.body as z.infer<typeof ProviderSchemas.availabilityBody>;
      const profile = await this.coverage.replaceAvailability(
        await this.profiles.getOwn(req.user!.id),
        body.slots.map((s) => ({ dayOfWeek: s.day_of_week, startTime: s.start_time, endTime: s.end_time })),
      );
      return HttpResponse.ok(res, { slots: presentAvailability(profile.availability) });
    } catch (err) {
      next(err);
    }
  }

  private async listTimeOff(req: Request, res: Response, next: NextFunction) {
    try {
      const profile = await this.profiles.getOwn(req.user!.id);
      return HttpResponse.ok(res, (await this.coverage.listTimeOff(profile._id)).map(presentTimeOff));
    } catch (err) {
      next(err);
    }
  }

  private async addTimeOff(req: Request, res: Response, next: NextFunction) {
    try {
      const body = req.body as z.infer<typeof ProviderSchemas.timeOffBody>;
      const profile = await this.profiles.getOwn(req.user!.id);
      const timeOff = await this.coverage.addTimeOff(profile._id, {
        startsAt: new Date(body.starts_at),
        endsAt: new Date(body.ends_at),
        reason: body.reason,
      });
      return HttpResponse.created(res, presentTimeOff(timeOff));
    } catch (err) {
      next(err);
    }
  }

  private async removeTimeOff(req: Request, res: Response, next: NextFunction) {
    try {
      const profile = await this.profiles.getOwn(req.user!.id);
      await this.coverage.removeTimeOff(profile._id, req.params.id);
      return HttpResponse.noContent(res);
    } catch (err) {
      next(err);
    }
  }

  private async accepting(req: Request, res: Response, next: NextFunction) {
    try {
      const profile = await this.profiles.setAccepting(req.user!.id, req.body.is_accepting_bookings);
      return HttpResponse.ok(res, presentProviderProfile(profile, await this.profiles.checklist(profile)));
    } catch (err) {
      next(err);
    }
  }
}
