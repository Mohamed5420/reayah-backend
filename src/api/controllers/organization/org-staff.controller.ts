import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { Container } from 'typedi';
import type IBaseController from '../interfaces/base-controller.interface';
import { CheckAppStatusMiddleware } from '../../middlewares/app';
import { Auth } from '../../middlewares/auth';
import { StaffSchemas } from '../../validations/organization/organization.validation';
import { type z } from '../../validations/zod';
import {
  presentReceivedInvite,
  presentStaffDetail,
  presentStaffInvite,
  presentStaffMember,
} from '../../presenters/organization.presenter';
import { defineRoute, type DefinedRoute } from '../../../docs/openapi';
import { OrganizationService, StaffService } from '../../../services/organization';
import { ProviderCoverageService } from '../../../services/provider';
import { LocationService } from '../../../services/location';
import { StorageService } from '../../../services/storage';
import { UserRole } from '../../../interfaces/enums';
import { UserModel } from '../../../database/models/user/user.model';
import { HttpResponse } from '../../../utils/response/http-response';
import { parsePagination } from '../../../utils/response/pagination';
import { resolveLanguage } from '../../../utils/i18n';

const tags = ['Owner — Team'];
const auth = true;
const params = StaffSchemas.idParams;

const r = {
  list: defineRoute({
    method: 'get',
    path: '/org/staff',
    summary: 'Team list',
    tags,
    auth,
    request: { query: StaffSchemas.listQuery },
    response: { schema: StaffSchemas.member, paginated: true },
  }),
  invite: defineRoute({
    method: 'post',
    path: '/org/staff/invite',
    summary:
      'Invite a nurse / doctor by phone (approved organizations; 30 a day). New numbers sign up with it; independent providers accept in the app (no active bookings, zero balance). Valid 7 days.',
    tags,
    auth,
    request: { body: StaffSchemas.inviteBody },
    response: { status: 201, schema: StaffSchemas.invite },
  }),
  invites: defineRoute({
    method: 'get',
    path: '/org/staff/invites',
    summary: 'Pending invites',
    tags,
    auth,
    response: { schema: StaffSchemas.invite.array() },
  }),
  revoke: defineRoute({
    method: 'delete',
    path: '/org/staff/invites/:id',
    summary: 'Revoke an invite',
    tags,
    auth,
    request: { params },
    response: { status: 204 },
  }),
  detail: defineRoute({
    method: 'get',
    path: '/org/staff/:id',
    summary: 'Staff member: details, services, areas, weekly hours and performance',
    tags,
    auth,
    request: { params },
    response: { schema: StaffSchemas.detail },
  }),
  update: defineRoute({
    method: 'patch',
    path: '/org/staff/:id',
    summary:
      'Suspend / reactivate within the organization; set services (from the organization’s, at its prices)',
    tags,
    auth,
    request: { params, body: StaffSchemas.updateBody },
    response: { schema: StaffSchemas.detail },
  }),
  remove: defineRoute({
    method: 'delete',
    path: '/org/staff/:id',
    summary:
      'Remove from the organization (always allowed). They become an independent provider, keep their verification, and take no bookings until they set their own areas, services and prices.',
    tags,
    auth,
    request: { params },
    response: { status: 204 },
  }),
  availability: defineRoute({
    method: 'put',
    path: '/org/staff/:id/availability',
    summary: 'Set the staff member’s weekly hours (Africa/Cairo)',
    tags,
    auth,
    request: { params, body: StaffSchemas.availabilityBody },
    response: { schema: StaffSchemas.detail },
  }),
  areas: defineRoute({
    method: 'put',
    path: '/org/staff/:id/service-areas',
    summary: 'Set the staff member’s areas (from the organization’s; its travel fee applies)',
    tags,
    auth,
    request: { params, body: StaffSchemas.areasBody },
    response: { schema: StaffSchemas.detail },
  }),
  received: defineRoute({
    method: 'get',
    path: '/provider/staff-invites',
    summary: 'Organizations inviting me to join their team (independent providers)',
    tags: ['Provider — Onboarding'],
    auth,
    response: { schema: StaffSchemas.receivedInvite.array() },
  }),
  accept: defineRoute({
    method: 'post',
    path: '/provider/staff-invites/:id/accept',
    summary:
      'Join the organization as staff (needs no active bookings, a zero balance and no open payout). Areas, services and prices are then set by the owner; refresh the session to get the new role.',
    tags: ['Provider — Onboarding'],
    auth,
    request: { params },
    response: { status: 204 },
  }),
  decline: defineRoute({
    method: 'post',
    path: '/provider/staff-invites/:id/decline',
    summary: 'Decline an invite',
    tags: ['Provider — Onboarding'],
    auth,
    request: { params },
    response: { status: 204 },
  }),
};

/** Owner — team management (spec §7.11 "Dashboard & team", M3.2) + invites seen by providers. */
export default class OrgStaffController implements IBaseController {
  path = '/org/staff';
  router = Router();

  private organizations = Container.get(OrganizationService);
  private staff = Container.get(StaffService);
  private coverage = Container.get(ProviderCoverageService);
  private locations = Container.get(LocationService);
  private storage = Container.get(StorageService);

  constructor() {
    this.initializeRoutes();
  }

  initializeRoutes() {
    const org = (req: Request) => this.organizations.getOwn(req.user!.id);
    const owner = [UserRole.OWNER];

    this.mount(r.list, owner, async (req, res) => {
      const q = req.query as unknown as z.infer<typeof StaffSchemas.listQuery>;
      const pagination = parsePagination(req.query);
      const { data, total } = await this.staff.list(
        (await org(req))._id,
        { status: q.status, type: q.type },
        pagination,
      );
      const rows = await Promise.all(
        data.map(async ({ profile, user }) =>
          presentStaffMember(
            profile,
            user,
            user.avatarKey ? await this.storage.signedUrl(user.avatarKey) : null,
          ),
        ),
      );
      return HttpResponse.paginated(res, rows, pagination, total);
    });
    this.mount(r.invite, owner, async (req, res) => {
      const body = req.body as z.infer<typeof StaffSchemas.inviteBody>;
      const invite = await this.staff.invite(await org(req), req.user!.id, {
        phone: body.phone,
        fullName: body.full_name,
        type: body.type,
      });
      return HttpResponse.created(res, presentStaffInvite(invite));
    });
    // Before /:id so "invites" isn't taken for an id.
    this.mount(r.invites, owner, async (req, res) =>
      HttpResponse.ok(res, (await this.staff.pendingInvites((await org(req))._id)).map(presentStaffInvite)),
    );
    this.mount(r.revoke, owner, async (req, res) => {
      await this.staff.revoke((await org(req))._id, req.params.id);
      return HttpResponse.noContent(res);
    });
    this.mount(r.detail, owner, async (req, res) =>
      HttpResponse.ok(res, await this.detail((await org(req))._id, req.params.id, req)),
    );
    this.mount(r.update, owner, async (req, res) => {
      const body = req.body as z.infer<typeof StaffSchemas.updateBody>;
      const organization = await org(req);
      await this.staff.update(organization, req.params.id, {
        status: body.status,
        serviceIds: body.service_ids,
      });
      return HttpResponse.ok(res, await this.detail(organization._id, req.params.id, req));
    });
    this.mount(r.remove, owner, async (req, res) => {
      await this.staff.remove(await org(req), req.params.id);
      return HttpResponse.noContent(res);
    });
    this.mount(r.availability, owner, async (req, res) => {
      const body = req.body as z.infer<typeof StaffSchemas.availabilityBody>;
      const organization = await org(req);
      await this.staff.setAvailability(
        organization._id,
        req.params.id,
        body.slots.map((s) => ({ dayOfWeek: s.day_of_week, startTime: s.start_time, endTime: s.end_time })),
      );
      return HttpResponse.ok(res, await this.detail(organization._id, req.params.id, req));
    });
    this.mount(r.areas, owner, async (req, res) => {
      const body = req.body as z.infer<typeof StaffSchemas.areasBody>;
      const organization = await org(req);
      await this.staff.setAreas(organization, req.params.id, body.area_ids);
      return HttpResponse.ok(res, await this.detail(organization._id, req.params.id, req));
    });

    // The invitee's side (independent providers).
    this.mount(r.received, [UserRole.PROVIDER], async (req, res) => {
      const user = await UserModel.findById(req.user!.id).select('phone').lean();
      const invites = user ? await this.staff.invitesForPhone(user.phone) : [];
      return HttpResponse.ok(res, invites.map(presentReceivedInvite));
    });
    this.mount(r.accept, [UserRole.PROVIDER], async (req, res) => {
      await this.staff.accept(req.user!.id, req.params.id);
      return HttpResponse.noContent(res);
    });
    this.mount(r.decline, [UserRole.PROVIDER], async (req, res) => {
      await this.staff.decline(req.user!.id, req.params.id);
      return HttpResponse.noContent(res);
    });
  }

  private async detail(orgId: Parameters<StaffService['details']>[0], id: string, req: Request) {
    const { profile, user, performance } = await this.staff.details(orgId, id);
    const [places, catalog, avatarUrl] = await Promise.all([
      this.locations.describeAreas(profile.serviceAreas.map((a) => String(a.areaId))),
      this.coverage.describeServices(profile),
      user?.avatarKey ? this.storage.signedUrl(user.avatarKey) : null,
    ]);
    return presentStaffDetail({
      profile,
      user: user!,
      avatarUrl,
      places,
      catalog,
      performance,
      lang: resolveLanguage(req),
    });
  }

  private mount(
    route: DefinedRoute,
    roles: UserRole[],
    handler: (req: Request, res: Response) => Promise<unknown>,
  ) {
    this.router[route.method](
      route.path,
      CheckAppStatusMiddleware,
      route.validate,
      ...Auth(...roles),
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
