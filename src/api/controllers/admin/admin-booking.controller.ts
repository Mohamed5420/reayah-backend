import { Router, type NextFunction, type Request, type Response } from 'express';
import { Container } from 'typedi';
import type IBaseController from '../interfaces/base-controller.interface';
import { CheckAppStatusMiddleware } from '../../middlewares/app';
import { AdminGuard } from '../../middlewares/auth';
import { AdminSchemas } from '../../validations/admin/admin.validation';
import { AftercareSchemas } from '../../validations/aftercare/aftercare.validation';
import { paginationQuery, type z } from '../../validations/zod';
import { presentAdminBooking, presentAdminBookingDetail } from '../../presenters/admin.presenter';
import { presentAdminDispute, presentAdminReview } from '../../presenters/aftercare.presenter';
import { defineRoute, type DefinedRoute } from '../../../docs/openapi';
import { AdminBookingService } from '../../../services/admin';
import { DisputeService, ReviewService } from '../../../services/aftercare';
import { auditContextFrom } from '../../../services/audit';
import { HttpResponse } from '../../../utils/response/http-response';
import { parsePagination, type Pagination } from '../../../utils/response/pagination';

const auth = true;
const params = AdminSchemas.idParams;
const bookings = ['Admin — Bookings & disputes'];
const reviews = ['Admin — Reviews'];

const r = {
  bookings: defineRoute({
    method: 'get',
    path: '/admin/bookings',
    summary: 'Bookings, latest visit first. `search` matches the reference code.',
    tags: bookings,
    auth,
    request: { query: AdminSchemas.bookingsQuery.extend(paginationQuery.shape) },
    response: { schema: AdminSchemas.booking, paginated: true },
  }),
  booking: defineRoute({
    method: 'get',
    path: '/admin/bookings/:id',
    summary: 'Full details + status history + offers (payments: Phase 2)',
    tags: bookings,
    auth,
    request: { params },
    response: { schema: AdminSchemas.bookingDetail },
  }),
  forceStatus: defineRoute({
    method: 'post',
    path: '/admin/bookings/:id/status',
    summary:
      'Force cancel / no-show / complete where the state machine allows it (completing records the commission). Disputes: patient flow; providers: /reassign.',
    tags: bookings,
    auth,
    request: { params, body: AdminSchemas.forceStatusBody },
    response: { schema: AdminSchemas.bookingDetail },
  }),
  reassign: defineRoute({
    method: 'post',
    path: '/admin/bookings/:id/reassign',
    summary:
      'Give a pending / accepted booking to another approved provider who offers the service and is free then; it becomes accepted',
    tags: bookings,
    auth,
    request: { params, body: AdminSchemas.reassignBody },
    response: { schema: AdminSchemas.bookingDetail },
  }),
  disputes: defineRoute({
    method: 'get',
    path: '/admin/disputes',
    summary: 'Disputes, oldest first',
    tags: bookings,
    auth,
    request: { query: AftercareSchemas.adminDisputesQuery.extend(paginationQuery.shape) },
    response: { schema: AftercareSchemas.adminDispute, paginated: true },
  }),
  dispute: defineRoute({
    method: 'get',
    path: '/admin/disputes/:id',
    summary: 'Dispute details with signed attachment URLs',
    tags: bookings,
    auth,
    request: { params },
    response: { schema: AftercareSchemas.adminDispute },
  }),
  resolve: defineRoute({
    method: 'post',
    path: '/admin/disputes/:id/resolve',
    summary:
      'Resolve: refund (defaults to the booking total) / partial refund / no action — recorded only until card payments (Phase 2); optionally warn or suspend the provider and message each side',
    tags: bookings,
    auth,
    request: { params, body: AftercareSchemas.resolveBody },
    response: { schema: AftercareSchemas.adminDispute },
  }),
  reviews: defineRoute({
    method: 'get',
    path: '/admin/reviews',
    summary: 'Reviews, newest first. `flagged=true`: comments that look like they contain contact details.',
    tags: reviews,
    auth,
    request: { query: AftercareSchemas.adminReviewsQuery.extend(paginationQuery.shape) },
    response: { schema: AftercareSchemas.adminReview, paginated: true },
  }),
  moderate: defineRoute({
    method: 'patch',
    path: '/admin/reviews/:id',
    summary: 'Hide / show, or mask contact details in the comment (the original is kept). Clears the flag.',
    tags: reviews,
    auth,
    request: { params, body: AftercareSchemas.moderateBody },
    response: { schema: AftercareSchemas.adminReview },
  }),
};

/** Admin panel: bookings, disputes and reviews (spec §7.15). Every write is audited. */
export default class AdminBookingController implements IBaseController {
  path = '/admin';
  router = Router();

  private bookings = Container.get(AdminBookingService);
  private disputes = Container.get(DisputeService);
  private reviews = Container.get(ReviewService);

  constructor() {
    this.initializeRoutes();
  }

  initializeRoutes() {
    this.list(r.bookings, async (req, pagination) => {
      const q = req.query as unknown as z.infer<typeof AdminSchemas.bookingsQuery>;
      const { data, total } = await this.bookings.list(
        {
          status: q.status,
          dateFrom: q.date_from ? new Date(q.date_from) : undefined,
          dateTo: q.date_to ? new Date(q.date_to) : undefined,
          areaId: q.area_id,
          search: q.search,
        },
        pagination,
      );
      return { data: data.map(presentAdminBooking), total };
    });
    this.mount(r.booking, (req) => this.bookingDetail(req.params.id));
    this.mount(r.forceStatus, async (req) => {
      const body = req.body as z.infer<typeof AdminSchemas.forceStatusBody>;
      await this.bookings.forceStatus(req.params.id, body, auditContextFrom(req));
      return this.bookingDetail(req.params.id);
    });
    this.mount(r.reassign, async (req) => {
      const body = req.body as z.infer<typeof AdminSchemas.reassignBody>;
      await this.bookings.reassign(req.params.id, body.provider_profile_id, auditContextFrom(req));
      return this.bookingDetail(req.params.id);
    });

    this.list(r.disputes, async (req, pagination) => {
      const q = req.query as unknown as z.infer<typeof AftercareSchemas.adminDisputesQuery>;
      const { data, total } = await this.disputes.list({ status: q.status }, pagination);
      return { data: await Promise.all(data.map((d) => this.disputeDetail(String(d._id)))), total };
    });
    this.mount(r.dispute, (req) => this.disputeDetail(req.params.id));
    this.mount(r.resolve, async (req) => {
      const body = req.body as z.infer<typeof AftercareSchemas.resolveBody>;
      await this.disputes.resolve(
        req.params.id,
        {
          resolution: body.resolution,
          refundAmount: body.refund_amount,
          providerAction: body.provider_action,
          suspendDays: body.suspend_days,
          messageToPatient: body.message_to_patient,
          messageToProvider: body.message_to_provider,
        },
        auditContextFrom(req),
      );
      return this.disputeDetail(req.params.id);
    });

    this.list(r.reviews, async (req, pagination) => {
      const q = req.query as unknown as z.infer<typeof AftercareSchemas.adminReviewsQuery>;
      const { data, total } = await this.reviews.adminList(
        { flagged: q.flagged, providerProfileId: q.provider_profile_id },
        pagination,
      );
      return { data: data.map(presentAdminReview), total };
    });
    this.mount(r.moderate, async (req) => {
      const body = req.body as z.infer<typeof AftercareSchemas.moderateBody>;
      const review = await this.reviews.moderate(
        req.params.id,
        { isVisible: body.is_visible, maskContact: body.mask_contact },
        auditContextFrom(req),
      );
      const [withName] = await this.reviews.withNames([review]);
      return presentAdminReview(withName);
    });
  }

  private async bookingDetail(id: string) {
    return presentAdminBookingDetail(await this.bookings.detail(id));
  }

  private async disputeDetail(id: string) {
    const { dispute, booking, attachments } = await this.disputes.get(id);
    return presentAdminDispute(dispute, booking?.referenceCode ?? null, attachments);
  }

  private chain(route: DefinedRoute) {
    return [CheckAppStatusMiddleware, route.validate, ...AdminGuard];
  }

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

  private list(
    route: DefinedRoute,
    handler: (req: Request, pagination: Pagination) => Promise<{ data: unknown[]; total: number }>,
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
