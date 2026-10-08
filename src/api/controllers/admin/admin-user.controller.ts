import { Router, type NextFunction, type Request, type Response } from 'express';
import { Container } from 'typedi';
import type IBaseController from '../interfaces/base-controller.interface';
import { CheckAppStatusMiddleware } from '../../middlewares/app';
import { AdminGuard } from '../../middlewares/auth';
import { AdminSchemas } from '../../validations/admin/admin.validation';
import { paginationQuery, z } from '../../validations/zod';
import {
  presentAdminUser,
  presentHistory,
  presentProviderDetail,
  presentProviderItem,
  presentUserDetail,
} from '../../presenters/admin.presenter';
import { defineRoute, type DefinedRoute } from '../../../docs/openapi';
import { AdminUserService } from '../../../services/admin';
import { AccountService } from '../../../services/moderation';
import { auditContextFrom } from '../../../services/audit';
import type { IProviderProfile } from '../../../interfaces/IProfiles';
import { HttpResponse } from '../../../utils/response/http-response';
import { parsePagination } from '../../../utils/response/pagination';

const auth = true;
const params = AdminSchemas.idParams;
const users = ['Admin — Users'];
const providers = ['Admin — Providers'];
const admins = ['Admin — Admin accounts'];

const r = {
  users: defineRoute({
    method: 'get',
    path: '/admin/users',
    summary: 'Users, newest first. `search` matches name or phone.',
    tags: users,
    auth,
    request: { query: AdminSchemas.usersQuery.extend(paginationQuery.shape) },
    response: { schema: AdminSchemas.user, paginated: true },
  }),
  user: defineRoute({
    method: 'get',
    path: '/admin/users/:id',
    summary: 'User details',
    tags: users,
    auth,
    request: { params },
    response: { schema: AdminSchemas.userDetail },
  }),
  suspend: defineRoute({
    method: 'post',
    path: '/admin/users/:id/suspend',
    summary:
      'Suspend (duration_days: null = until lifted). Sessions end, a provider stops taking bookings, and their active bookings are cancelled (the other side is notified).',
    tags: users,
    auth,
    request: { params, body: AdminSchemas.suspendBody },
    response: { schema: AdminSchemas.suspended },
  }),
  warn: defineRoute({
    method: 'post',
    path: '/admin/users/:id/warn',
    summary: 'Record a warning (optionally tied to a booking / dispute / review) and notify the user',
    tags: users,
    auth,
    request: { params, body: AdminSchemas.warnBody },
    response: { status: 201, schema: AdminSchemas.warning },
  }),
  activate: defineRoute({
    method: 'post',
    path: '/admin/users/:id/activate',
    summary: 'Lift the suspension',
    tags: users,
    auth,
    request: { params },
    response: { schema: AdminSchemas.user },
  }),
  history: defineRoute({
    method: 'get',
    path: '/admin/users/:id/history',
    summary: 'Suspensions, warnings, disputes and audit trail',
    tags: users,
    auth,
    request: { params },
    response: { schema: AdminSchemas.history },
  }),
  providers: defineRoute({
    method: 'get',
    path: '/admin/providers',
    summary: 'Providers, newest first',
    tags: providers,
    auth,
    request: { query: AdminSchemas.providersQuery.extend(paginationQuery.shape) },
    response: { schema: AdminSchemas.providerItem, paginated: true },
  }),
  provider: defineRoute({
    method: 'get',
    path: '/admin/providers/:id',
    summary: 'Provider details + bookings by status',
    tags: providers,
    auth,
    request: { params },
    response: { schema: AdminSchemas.providerDetail },
  }),
  updateProvider: defineRoute({
    method: 'patch',
    path: '/admin/providers/:id',
    summary:
      'Suspend the listing (approved → suspended: stops bookings, cancels active ones) or restore it, and/or set the admin message',
    tags: providers,
    auth,
    request: { params, body: AdminSchemas.providerPatch },
    response: { schema: AdminSchemas.providerDetail },
  }),
  admins: defineRoute({
    method: 'get',
    path: '/admin/admins',
    summary: 'Admin accounts',
    tags: admins,
    auth,
    response: { schema: z.array(AdminSchemas.user) },
  }),
  createAdmin: defineRoute({
    method: 'post',
    path: '/admin/admins',
    summary: 'Create an admin account with a sub-role (they sign in with phone + OTP). Super admins only.',
    tags: admins,
    auth,
    request: { body: AdminSchemas.adminCreateBody },
    response: { status: 201, schema: AdminSchemas.user },
  }),
  updateAdmin: defineRoute({
    method: 'patch',
    path: '/admin/admins/:id',
    summary:
      'Change another admin’s sub-role and / or disable / re-enable them (not yourself). Super admins only.',
    tags: admins,
    auth,
    request: { params, body: AdminSchemas.adminPatch },
    response: { schema: AdminSchemas.user },
  }),
};

/** Admin panel: users, providers and admin accounts (spec §7.15). Every write is audited. */
export default class AdminUserController implements IBaseController {
  path = '/admin';
  router = Router();

  private service = Container.get(AdminUserService);
  private accounts = Container.get(AccountService);

  constructor() {
    this.initializeRoutes();
  }

  initializeRoutes() {
    this.list(r.users, async (req, pagination) => {
      const q = req.query as unknown as z.infer<typeof AdminSchemas.usersQuery>;
      const { data, total } = await this.service.listUsers(q, pagination);
      return { data: data.map(presentAdminUser), total };
    });
    this.mount(r.user, async (req) => presentUserDetail(await this.service.getUser(req.params.id)));
    this.mount(r.suspend, async (req) => {
      const body = req.body as z.infer<typeof AdminSchemas.suspendBody>;
      const result = await this.accounts.suspend(
        req.params.id,
        { reason: body.reason, durationDays: body.duration_days, notify: body.notify },
        auditContextFrom(req),
      );
      return { ends_at: result.endsAt?.toISOString() ?? null, cancelled_bookings: result.cancelledBookings };
    });
    this.mount(
      r.warn,
      async (req) => {
        const body = req.body as z.infer<typeof AdminSchemas.warnBody>;
        const warning = await this.accounts.warn(
          req.params.id,
          {
            reason: body.reason,
            relatedType: body.related_type,
            relatedId: body.related_id,
            notify: body.notify,
          },
          auditContextFrom(req),
        );
        return {
          id: String(warning._id),
          reason: warning.reason,
          created_at: warning.createdAt.toISOString(),
        };
      },
      201,
    );
    this.mount(r.activate, async (req) => {
      await this.accounts.activate(req.params.id, auditContextFrom(req));
      return presentAdminUser((await this.service.getUser(req.params.id)).user);
    });
    this.mount(r.history, async (req) => presentHistory(await this.accounts.history(req.params.id)));

    this.list(r.providers, async (req, pagination) => {
      const q = req.query as unknown as z.infer<typeof AdminSchemas.providersQuery>;
      const { data, total } = await this.service.listProviders(
        { verificationStatus: q.verification_status, areaId: q.area_id, type: q.type },
        pagination,
      );
      return { data: data.map(presentProviderItem), total };
    });
    this.mount(r.provider, async (req) => this.providerDetail(req.params.id));
    this.mount(r.updateProvider, async (req) => {
      const body = req.body as z.infer<typeof AdminSchemas.providerPatch>;
      await this.service.updateProvider(
        req.params.id,
        { verificationStatus: body.verification_status, adminMessage: body.admin_message },
        auditContextFrom(req),
      );
      return this.providerDetail(req.params.id);
    });

    this.mount(r.admins, async () => (await this.service.listAdmins()).map(presentAdminUser));
    this.mount(
      r.createAdmin,
      async (req) => {
        const body = req.body as z.infer<typeof AdminSchemas.adminCreateBody>;
        return presentAdminUser(
          await this.service.createAdmin(
            { phone: body.phone, fullName: body.full_name, adminRole: body.admin_role },
            auditContextFrom(req),
          ),
        );
      },
      201,
    );
    this.mount(r.updateAdmin, async (req) => {
      const body = req.body as z.infer<typeof AdminSchemas.adminPatch>;
      return presentAdminUser(await this.service.updateAdmin(req.params.id, body, auditContextFrom(req)));
    });
  }

  private async providerDetail(id: string) {
    const { profile, user, bookingsByStatus } = await this.service.getProvider(id);
    // toObject() runs the getters that decrypt license / syndicate numbers.
    return presentProviderDetail({ profile: profile.toObject() as IProviderProfile, user, bookingsByStatus });
  }

  private chain(route: DefinedRoute) {
    return [CheckAppStatusMiddleware, route.validate, ...AdminGuard];
  }

  private mount(route: DefinedRoute, handler: (req: Request) => Promise<unknown>, status: 200 | 201 = 200) {
    this.router[route.method](
      route.path,
      ...this.chain(route),
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          const data = await handler(req);
          return status === 201 ? HttpResponse.created(res, data) : HttpResponse.ok(res, data);
        } catch (err) {
          next(err);
        }
      },
    );
  }

  private list(
    route: DefinedRoute,
    handler: (
      req: Request,
      pagination: ReturnType<typeof parsePagination>,
    ) => Promise<{ data: unknown[]; total: number }>,
  ) {
    this.router.get(
      route.path,
      ...this.chain(route),
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          const pagination = parsePagination(req.query);
          const { data, total } = await handler(req, pagination);
          return HttpResponse.paginated(res, data, pagination, total);
        } catch (err) {
          next(err);
        }
      },
    );
  }
}
