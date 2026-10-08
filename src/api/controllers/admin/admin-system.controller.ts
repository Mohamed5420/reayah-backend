import { Router, type NextFunction, type Request, type Response } from 'express';
import { Container } from 'typedi';
import type IBaseController from '../interfaces/base-controller.interface';
import { CheckAppStatusMiddleware } from '../../middlewares/app';
import { AdminGuard } from '../../middlewares/auth';
import { AdminSchemas } from '../../validations/admin/admin.validation';
import { paginationQuery, type z } from '../../validations/zod';
import { presentAttention, presentAuditEntry } from '../../presenters/admin.presenter';
import { defineRoute, type DefinedRoute } from '../../../docs/openapi';
import { AdminAnalyticsService, AdminDashboardService } from '../../../services/admin';
import { AuditService, auditContextFrom } from '../../../services/audit';
import { SettingsService } from '../../../services/settings';
import { HttpResponse } from '../../../utils/response/http-response';
import { parsePagination } from '../../../utils/response/pagination';

const auth = true;

const r = {
  dashboard: defineRoute({
    method: 'get',
    path: '/admin/dashboard',
    summary:
      'KPIs (bookings today, 30-day GMV / revenue, active providers, pending verifications, open disputes), 14-day chart, today by status, top areas, recent activity',
    tags: ['Admin — Dashboard'],
    auth,
    response: { schema: AdminSchemas.dashboard },
  }),
  analytics: defineRoute({
    method: 'get',
    path: '/admin/analytics',
    summary:
      'Time series: bookings, completed visits, GMV, revenue, cancellation rate, active providers, sign-ups — by Cairo day / week / month, zero-filled',
    tags: ['Admin — Dashboard'],
    auth,
    request: { query: AdminSchemas.analyticsQuery },
    response: { schema: AdminSchemas.analytics },
  }),
  attention: defineRoute({
    method: 'get',
    path: '/admin/attention',
    summary:
      'Needs attention: requests nobody took (last 24 h), open disputes, documents expired or expiring within 30 days',
    tags: ['Admin — Dashboard'],
    auth,
    response: { schema: AdminSchemas.attention },
  }),
  settings: defineRoute({
    method: 'get',
    path: '/admin/settings',
    summary: 'All platform settings (defaults merged with admin overrides)',
    tags: ['Admin — System'],
    auth,
    response: { schema: AdminSchemas.settings },
  }),
  updateSettings: defineRoute({
    method: 'put',
    path: '/admin/settings',
    summary: 'Change some settings — all-or-nothing; unknown keys / bad values → 422 per key',
    tags: ['Admin — System'],
    auth,
    request: { body: AdminSchemas.settingsBody },
    response: { schema: AdminSchemas.settings },
  }),
  auditLogs: defineRoute({
    method: 'get',
    path: '/admin/audit-logs',
    summary: 'Audit trail, newest first',
    tags: ['Admin — System'],
    auth,
    request: { query: AdminSchemas.auditQuery.extend(paginationQuery.shape) },
    response: { schema: AdminSchemas.auditEntry, paginated: true },
  }),
};

/** Admin panel: dashboard, settings and audit log (spec §7.15 "Dashboard", "System"). */
export default class AdminSystemController implements IBaseController {
  path = '/admin';
  router = Router();

  private dashboard = Container.get(AdminDashboardService);
  private analytics = Container.get(AdminAnalyticsService);
  private settings = Container.get(SettingsService);
  private audit = Container.get(AuditService);

  constructor() {
    this.initializeRoutes();
  }

  initializeRoutes() {
    this.mount(r.dashboard, async () => {
      const d = await this.dashboard.dashboard();
      return {
        kpis: {
          bookings_today: d.kpis.bookingsToday,
          gmv_30d: d.kpis.gmv30d,
          revenue_30d: d.kpis.revenue30d,
          completed_30d: d.kpis.completed30d,
          active_providers: d.kpis.activeProviders,
          pending_verifications: d.kpis.pendingVerifications,
          open_disputes: d.kpis.openDisputes,
        },
        bookings_14d: d.bookings14d,
        today_by_status: d.todayByStatus,
        top_areas: d.topAreas.map((a) => ({ area_name: a.areaName, bookings: a.bookings })),
        recent_activity: d.recentActivity.map(presentAuditEntry),
      };
    });
    this.mount(r.analytics, async (req) => {
      const q = req.query as unknown as z.infer<typeof AdminSchemas.analyticsQuery>;
      const { groupBy, ...rest } = await this.analytics.series({
        metric: q.metric,
        from: q.from,
        to: q.to,
        groupBy: q.group_by,
      });
      return { ...rest, group_by: groupBy };
    });
    this.mount(r.attention, async () => presentAttention(await this.dashboard.attention()));
    this.mount(r.settings, () => this.settings.getAll());
    this.mount(r.updateSettings, (req) =>
      this.settings.update(req.body as Record<string, unknown>, auditContextFrom(req)),
    );

    this.router.get(
      r.auditLogs.path,
      ...this.chain(r.auditLogs),
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          const q = req.query as unknown as z.infer<typeof AdminSchemas.auditQuery>;
          const pagination = parsePagination(req.query);
          const { data, total } = await this.audit.list(
            { actorId: q.actor_id, entityType: q.entity_type, entityId: q.entity_id, action: q.action },
            pagination,
          );
          return HttpResponse.paginated(res, data.map(presentAuditEntry), pagination, total);
        } catch (err) {
          next(err);
        }
      },
    );
  }

  private chain(route: DefinedRoute) {
    return [CheckAppStatusMiddleware, route.validate, ...AdminGuard];
  }

  /** Mounts a route whose handler returns the response `data` (200). */
  private mount(route: DefinedRoute, handler: (req: Request) => Promise<unknown>) {
    this.router[route.method](
      route.path,
      ...this.chain(route),
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          return HttpResponse.ok(res, await handler(req));
        } catch (err) {
          next(err);
        }
      },
    );
  }
}
