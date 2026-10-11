import { Router, type NextFunction, type Request, type Response } from 'express';
import { Container } from 'typedi';
import type IBaseController from '../interfaces/base-controller.interface';
import { CheckAppStatusMiddleware } from '../../middlewares/app';
import { Auth } from '../../middlewares/auth';
import { BookingSchemas } from '../../validations/booking/booking.validation';
import { AftercareSchemas } from '../../validations/aftercare/aftercare.validation';
import { z } from '../../validations/zod';
import { presentOffer, presentProviderDetail, presentProviderItem } from '../../presenters/booking.presenter';
import { presentProviderReview, presentVisitReport } from '../../presenters/aftercare.presenter';
import { defineRoute, type DefinedRoute } from '../../../docs/openapi';
import { ProviderBookingService } from '../../../services/booking';
import { ProviderProfileService } from '../../../services/provider';
import { ReviewService, VisitReportService, type VisitReportInput } from '../../../services/aftercare';
import { auditContextFrom } from '../../../services/audit';
import { UserRole } from '../../../interfaces/enums';
import type { IBooking } from '../../../interfaces/IBooking';
import { HttpResponse } from '../../../utils/response/http-response';
import { parsePagination } from '../../../utils/response/pagination';
import { resolveLanguage } from '../../../utils/i18n';

const tags = ['Provider — Bookings'];
const auth = true;
const params = BookingSchemas.idParams;
const detail = { schema: BookingSchemas.providerDetail };

/** Visit actions: POST /provider/bookings/{id}/<action>, each a state-machine transition. */
const action = (name: string, summary: string, body?: z.ZodType) =>
  defineRoute({
    method: 'post',
    path: `/provider/bookings/:id/${name}`,
    summary,
    tags,
    auth,
    request: { params, ...(body ? { body } : {}) },
    response: detail,
  });

const r = {
  home: defineRoute({
    method: 'get',
    path: '/provider/home',
    summary: "Dashboard: today's visits, pending requests, open offers, today's earnings",
    tags,
    auth,
    response: { schema: BookingSchemas.providerHome },
  }),
  list: defineRoute({
    method: 'get',
    path: '/provider/bookings',
    summary: 'My bookings',
    tags,
    auth,
    request: { query: BookingSchemas.providerListQuery },
    response: { schema: BookingSchemas.providerItem, paginated: true },
  }),
  detail: defineRoute({
    method: 'get',
    path: '/provider/bookings/:id',
    summary:
      'Details. Patient, phone, address and notes only once accepted; medical summary only during the visit + 7 days (audited).',
    tags,
    auth,
    request: { params },
    response: detail,
  }),
  accept: action('accept', 'Accept a direct request (before the response deadline)'),
  decline: action('decline', 'Decline a direct request', BookingSchemas.declineBody),
  onTheWay: action('on-the-way', 'Manual "on my way" (no location is collected)'),
  start: action(
    'start',
    'Start the visit (records whether it was on time). Clinic visits: with the patient’s 4-digit visit_code (5 tries), or without_code_reason (audited).',
    BookingSchemas.startBody,
  ),
  complete: action('complete', 'End the visit'),
  noShow: action('no-show', 'Patient not available (from the booked time on)'),
  cancel: action('cancel', 'Cancel an accepted visit', BookingSchemas.providerCancelBody),
  cashCollected: action('cash-collected', 'Confirm the cash was received'),
  offers: defineRoute({
    method: 'get',
    path: '/provider/offers',
    summary: 'Open requests offered to several providers — first to accept wins',
    tags,
    auth,
    response: { schema: z.array(BookingSchemas.offer) },
  }),
  acceptOffer: defineRoute({
    method: 'post',
    path: '/provider/offers/:id/accept',
    summary: 'Accept an offer — 409 OFFER_TAKEN if someone accepted first',
    tags,
    auth,
    request: { params },
    response: detail,
  }),
  declineOffer: defineRoute({
    method: 'post',
    path: '/provider/offers/:id/decline',
    summary: 'Decline an offer',
    tags,
    auth,
    request: { params },
    response: { status: 204 },
  }),
  submitReport: defineRoute({
    method: 'post',
    path: '/provider/bookings/:id/report',
    summary:
      "Visit report (from the start of the visit) — added to the patient's medical record; the patient is notified",
    tags,
    auth,
    request: { params, body: AftercareSchemas.reportBody },
    response: { status: 201, schema: AftercareSchemas.visitReport },
  }),
  editReport: defineRoute({
    method: 'patch',
    path: '/provider/bookings/:id/report',
    summary: 'Correct the report — within 24 hours of submitting it',
    tags,
    auth,
    request: { params, body: AftercareSchemas.reportPatch },
    response: { schema: AftercareSchemas.visitReport },
  }),
  reviews: defineRoute({
    method: 'get',
    path: '/provider/reviews',
    summary: 'My reviews (visible ones): sort newest (default), highest or lowest rating',
    tags: ['Provider — Reviews'],
    auth,
    request: { query: AftercareSchemas.providerReviewsQuery },
    response: { schema: AftercareSchemas.providerReview, paginated: true },
  }),
  reviewSummary: defineRoute({
    method: 'get',
    path: '/provider/reviews/summary',
    summary: 'My rating at a glance: average and count, visible reviews per star, the most chosen tags',
    tags: ['Provider — Reviews'],
    auth,
    response: { schema: AftercareSchemas.reviewSummary },
  }),
};

type ReportBody = z.infer<typeof AftercareSchemas.reportPatch>;
const reportInput = (body: ReportBody): Partial<VisitReportInput> => ({
  summary: body.summary,
  vitals: body.vitals,
  proceduresDone: body.procedures_done,
  recommendations: body.recommendations,
  attachments: body.attachments,
});

/** Provider bookings, offers, visit reports and reviews (spec §7.10). */
export default class ProviderBookingController implements IBaseController {
  path = '/provider';
  router = Router();

  private bookings = Container.get(ProviderBookingService);
  private profiles = Container.get(ProviderProfileService);
  private reports = Container.get(VisitReportService);
  private reviews = Container.get(ReviewService);

  constructor() {
    this.initializeRoutes();
  }

  initializeRoutes() {
    this.mount(r.home, async (req) => {
      const home = await this.bookings.home(await this.profile(req));
      const lang = resolveLanguage(req);
      return {
        today_visits: home.todayVisits.map((b) => presentProviderItem(b, lang)),
        pending_requests: home.pendingRequests.map((b) => presentProviderItem(b, lang)),
        open_offers: home.openOffers,
        today_earnings: home.todayEarnings,
        currency: 'EGP',
      };
    });

    this.router.get(
      r.list.path,
      ...this.chain(r.list),
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          const q = req.query as unknown as z.infer<typeof BookingSchemas.providerListQuery>;
          const pagination = parsePagination(req.query);
          const { data, total } = await this.bookings.list(
            await this.profile(req),
            { status: q.status, date: q.date },
            pagination,
          );
          const lang = resolveLanguage(req);
          return HttpResponse.paginated(
            res,
            data.map((b) => presentProviderItem(b, lang)),
            pagination,
            total,
          );
        } catch (err) {
          next(err);
        }
      },
    );

    this.mount(r.detail, (req) => this.detailOf(req));

    const visit = (route: DefinedRoute, run: (req: Request) => Promise<unknown>) =>
      this.mount(route, async (req) => {
        await run(req);
        return this.detailOf(req);
      });
    visit(r.accept, async (req) =>
      this.bookings.accept(await this.profile(req), req.params.id, req.user!.id),
    );
    visit(r.decline, async (req) =>
      this.bookings.decline(await this.profile(req), req.params.id, req.user!.id, req.body.reason_code),
    );
    visit(r.onTheWay, async (req) =>
      this.bookings.onTheWay(await this.profile(req), req.params.id, req.user!.id),
    );
    visit(r.start, async (req) => {
      const body = (req.body ?? {}) as z.infer<typeof BookingSchemas.startBody>;
      return this.bookings.start(
        await this.profile(req),
        req.params.id,
        req.user!.id,
        { visitCode: body.visit_code, withoutCodeReason: body.without_code_reason },
        auditContextFrom(req),
      );
    });
    visit(r.complete, async (req) =>
      this.bookings.complete(await this.profile(req), req.params.id, req.user!.id),
    );
    visit(r.noShow, async (req) =>
      this.bookings.noShow(await this.profile(req), req.params.id, req.user!.id),
    );
    visit(r.cancel, async (req) =>
      this.bookings.cancel(await this.profile(req), req.params.id, req.user!.id, {
        code: req.body.reason_code,
        text: req.body.reason_text,
      }),
    );
    visit(r.cashCollected, async (req) =>
      this.bookings.cashCollected(await this.profile(req), req.params.id),
    );

    this.mount(r.offers, async (req) => {
      const lang = resolveLanguage(req);
      return (await this.bookings.listOffers(await this.profile(req))).map(({ offer, booking }) =>
        presentOffer(offer, booking, lang),
      );
    });
    this.mount(r.acceptOffer, async (req) => {
      const booking = await this.bookings.acceptOffer(await this.profile(req), req.params.id, req.user!.id);
      return this.detailOf(req, booking.toObject());
    });
    this.router.post(
      r.declineOffer.path,
      ...this.chain(r.declineOffer),
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          await this.bookings.declineOffer(await this.profile(req), req.params.id);
          return HttpResponse.noContent(res);
        } catch (err) {
          next(err);
        }
      },
    );

    this.router.post(
      r.submitReport.path,
      ...this.chain(r.submitReport),
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          const report = await this.reports.submit(
            await this.profile(req),
            req.params.id,
            req.user!.id,
            reportInput(req.body as ReportBody) as VisitReportInput,
          );
          const d = await this.reports.withDetails(report);
          return HttpResponse.created(res, presentVisitReport(d.report, d.provider, d.attachments));
        } catch (err) {
          next(err);
        }
      },
    );
    this.mount(r.editReport, async (req) => {
      const report = await this.reports.update(
        await this.profile(req),
        req.params.id,
        req.user!.id,
        reportInput(req.body as ReportBody),
      );
      const d = await this.reports.withDetails(report);
      return presentVisitReport(d.report, d.provider, d.attachments);
    });

    this.router.get(
      r.reviewSummary.path,
      ...this.chain(r.reviewSummary),
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          const profile = await this.profile(req);
          const summary = await this.reviews.summaryForProvider(profile._id);
          return HttpResponse.ok(res, {
            rating_avg: profile.ratingAvg,
            rating_count: profile.ratingCount,
            distribution: summary.distribution,
            top_tags: summary.topTags,
          });
        } catch (err) {
          next(err);
        }
      },
    );

    this.router.get(
      r.reviews.path,
      ...this.chain(r.reviews),
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          const pagination = parsePagination(req.query);
          const profile = await this.profile(req);
          const q = req.query as unknown as { sort: 'newest' | 'highest' | 'lowest' };
          const { data, total } = await this.reviews.listForProvider(profile._id, pagination, q.sort);
          return HttpResponse.paginated(res, data.map(presentProviderReview), pagination, total);
        } catch (err) {
          next(err);
        }
      },
    );
  }

  private chain(route: DefinedRoute) {
    return [CheckAppStatusMiddleware, route.validate, ...Auth(UserRole.PROVIDER, UserRole.PROVIDER_STAFF)];
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

  private profile(req: Request) {
    return this.profiles.getOwn(req.user!.id);
  }

  private async detailOf(req: Request, booking?: IBooking) {
    const result = await this.bookings.getDetail(
      await this.profile(req),
      booking ? String(booking._id) : req.params.id,
      auditContextFrom(req),
    );
    return presentProviderDetail({ ...result, lang: resolveLanguage(req) });
  }
}
