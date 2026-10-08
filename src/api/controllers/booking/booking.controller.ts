import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { Container } from 'typedi';
import type IBaseController from '../interfaces/base-controller.interface';
import { CheckAppStatusMiddleware, IdempotencyMiddleware } from '../../middlewares/app';
import { Auth } from '../../middlewares/auth';
import { BookingSchemas } from '../../validations/booking/booking.validation';
import { AftercareSchemas } from '../../validations/aftercare/aftercare.validation';
import { type z } from '../../validations/zod';
import {
  presentCreated,
  presentDetail,
  presentListItem,
  presentQuote,
} from '../../presenters/booking.presenter';
import { presentDispute, presentReview } from '../../presenters/aftercare.presenter';
import { defineRoute, type DefinedRoute } from '../../../docs/openapi';
import { BookingService, QuoteService, type QuoteInput } from '../../../services/booking';
import { StorageService } from '../../../services/storage';
import { PaymentService } from '../../../services/payments/payment.service';
import { GATEWAY_PAYMENT_METHODS } from '../../../interfaces/IBooking';
import { DisputeService, ReviewService } from '../../../services/aftercare';
import { UserModel } from '../../../database/models/user/user.model';
import { ProviderProfileModel } from '../../../database/models/provider/provider-profile.model';
import { UserRole } from '../../../interfaces/enums';
import { HttpResponse } from '../../../utils/response/http-response';
import { parsePagination } from '../../../utils/response/pagination';
import { resolveLanguage } from '../../../utils/i18n';

const tags = ['Patient — Bookings'];
const auth = true;

const r = {
  quote: defineRoute({
    method: 'post',
    path: '/bookings/quote',
    summary: 'Price breakdown + a quote token that guarantees it for 10 minutes',
    tags,
    auth,
    request: { body: BookingSchemas.quoteBody },
    response: { schema: BookingSchemas.quote },
  }),
  create: defineRoute({
    method: 'post',
    path: '/bookings',
    summary: 'Book from a quote (cash only in Phase 1). 409 SLOT_UNAVAILABLE if the time was just taken.',
    tags,
    auth,
    idempotent: true,
    request: { body: BookingSchemas.createBody },
    response: { status: 201, schema: BookingSchemas.created },
  }),
  list: defineRoute({
    method: 'get',
    path: '/bookings',
    summary: 'My bookings — upcoming (soonest first) or past (latest first)',
    tags,
    auth,
    request: { query: BookingSchemas.listQuery },
    response: { schema: BookingSchemas.listItem, paginated: true },
  }),
  detail: defineRoute({
    method: 'get',
    path: '/bookings/:id',
    summary: 'Booking details + status timeline (manual status updates — no location tracking)',
    tags,
    auth,
    request: { params: BookingSchemas.idParams },
    response: { schema: BookingSchemas.detail },
  }),
  cancel: defineRoute({
    method: 'post',
    path: '/bookings/:id/cancel',
    summary: 'Cancel (free while pending, and until the cancellation window before the visit)',
    tags,
    auth,
    request: { params: BookingSchemas.idParams, body: BookingSchemas.cancelBody },
    response: { schema: BookingSchemas.cancelled },
  }),
  reschedule: defineRoute({
    method: 'post',
    path: '/bookings/:id/reschedule',
    summary: 'New time with the same provider — goes back to pending until they accept',
    tags,
    auth,
    request: { params: BookingSchemas.idParams, body: BookingSchemas.rescheduleBody },
    response: { schema: BookingSchemas.detail },
  }),
  rebook: defineRoute({
    method: 'post',
    path: '/bookings/:id/rebook',
    summary: 'Same service, provider, patient and address at a new time — returns a quote',
    tags,
    auth,
    request: { params: BookingSchemas.idParams, body: BookingSchemas.rescheduleBody },
    response: { schema: BookingSchemas.quote },
  }),
  review: defineRoute({
    method: 'post',
    path: '/bookings/:id/review',
    summary: 'Rate a completed visit — once per booking (409 ALREADY_REVIEWED)',
    tags,
    auth,
    request: { params: BookingSchemas.idParams, body: AftercareSchemas.reviewBody },
    response: { status: 201, schema: AftercareSchemas.review },
  }),
  dispute: defineRoute({
    method: 'post',
    path: '/bookings/:id/dispute',
    summary:
      'Report a problem with a completed visit or a recorded no-show, within the dispute window (setting dispute_window_hours). The booking becomes "disputed".',
    tags,
    auth,
    request: { params: BookingSchemas.idParams, body: AftercareSchemas.disputeBody },
    response: { status: 201, schema: AftercareSchemas.dispute },
  }),
};

/** Patient bookings (spec §7.8). */
export default class BookingController implements IBaseController {
  path = '/bookings';
  router = Router();

  private bookings = Container.get(BookingService);
  private quotes = Container.get(QuoteService);
  private storage = Container.get(StorageService);
  private payments = Container.get(PaymentService);
  private reviews = Container.get(ReviewService);
  private disputes = Container.get(DisputeService);

  constructor() {
    this.initializeRoutes();
  }

  initializeRoutes() {
    this.mount(r.quote, this.quote);
    this.router.post(
      r.create.path,
      CheckAppStatusMiddleware,
      r.create.validate,
      ...Auth(UserRole.PATIENT),
      IdempotencyMiddleware,
      this.create.bind(this),
    );
    this.mount(r.list, this.list);
    this.mount(r.detail, this.detail);
    this.mount(r.cancel, this.cancel);
    this.mount(r.reschedule, this.reschedule);
    this.mount(r.rebook, this.rebook);
    this.mount(r.review, this.review);
    this.mount(r.dispute, this.dispute);
  }

  private mount(route: DefinedRoute, handler: RequestHandler) {
    this.router[route.method](
      route.path,
      CheckAppStatusMiddleware,
      route.validate,
      ...Auth(UserRole.PATIENT),
      handler.bind(this),
    );
  }

  private async quote(req: Request, res: Response, next: NextFunction) {
    try {
      const body = req.body as z.infer<typeof BookingSchemas.quoteBody>;
      const input: QuoteInput = {
        serviceId: body.service_id,
        providerId: body.provider_id ?? null,
        organizationId: body.organization_id ?? null,
        patientProfileId: body.patient_profile_id,
        addressId: body.address_id,
        type: body.type,
        preferredGender: body.preferred_gender,
        allowFallback: body.allow_fallback,
        scheduledStart: new Date(body.scheduled_start),
        quantity: body.quantity,
        promoCode: body.promo_code ?? null,
        packageSubscriptionId: body.package_subscription_id ?? null,
      };
      return HttpResponse.ok(
        res,
        presentQuote(await this.quotes.quote(req.user!.id, input, resolveLanguage(req))),
      );
    } catch (err) {
      next(err);
    }
  }

  private async create(req: Request, res: Response, next: NextFunction) {
    try {
      const body = req.body as z.infer<typeof BookingSchemas.createBody>;
      const booking = await this.bookings.create(req.user!.id, {
        quoteToken: body.quote_token,
        paymentMethod: body.payment_method,
        patientNotes: body.patient_notes,
      });
      // Card / wallet: start the checkout right away. If the gateway is down the booking still stands
      // and the app can retry with POST /payments/initiate.
      let payment = null;
      if (GATEWAY_PAYMENT_METHODS.includes(booking.paymentMethod)) {
        payment = await this.payments
          .initiateForBooking(req.user!.id, String(booking._id))
          .then((p) => ({ id: String(p._id), checkoutUrl: p.checkoutUrl, expiresAt: p.expiresAt }))
          .catch(() => null);
      }
      return HttpResponse.created(res, presentCreated(booking, payment));
    } catch (err) {
      next(err);
    }
  }

  private async list(req: Request, res: Response, next: NextFunction) {
    try {
      const q = req.query as unknown as z.infer<typeof BookingSchemas.listQuery>;
      const pagination = parsePagination(req.query);
      const { data, total, providers, organizations } = await this.bookings.list(
        req.user!.id,
        { scope: q.scope, status: q.status },
        pagination,
      );
      const lang = resolveLanguage(req);
      return HttpResponse.paginated(
        res,
        data.map((b) =>
          presentListItem(
            b,
            b.providerProfileId ? providers.get(String(b.providerProfileId)) : undefined,
            lang,
            b.organizationId ? (organizations.get(String(b.organizationId)) ?? null) : null,
          ),
        ),
        pagination,
        total,
      );
    } catch (err) {
      next(err);
    }
  }

  private async detail(req: Request, res: Response, next: NextFunction) {
    try {
      return HttpResponse.ok(res, await this.detailOf(req));
    } catch (err) {
      next(err);
    }
  }

  private async cancel(req: Request, res: Response, next: NextFunction) {
    try {
      const body = req.body as z.infer<typeof BookingSchemas.cancelBody>;
      const result = await this.bookings.cancel(req.user!.id, req.params.id, {
        code: body.reason_code,
        text: body.reason_text,
      });
      return HttpResponse.ok(res, {
        status: result.status,
        cancellation_fee: result.cancellationFee,
        refund_amount: result.refundAmount,
      });
    } catch (err) {
      next(err);
    }
  }

  private async reschedule(req: Request, res: Response, next: NextFunction) {
    try {
      await this.bookings.reschedule(req.user!.id, req.params.id, new Date(req.body.scheduled_start));
      return HttpResponse.ok(res, await this.detailOf(req));
    } catch (err) {
      next(err);
    }
  }

  private async rebook(req: Request, res: Response, next: NextFunction) {
    try {
      const quote = await this.bookings.rebook(
        req.user!.id,
        req.params.id,
        new Date(req.body.scheduled_start),
        resolveLanguage(req),
      );
      return HttpResponse.ok(res, presentQuote(quote));
    } catch (err) {
      next(err);
    }
  }

  private async review(req: Request, res: Response, next: NextFunction) {
    try {
      const body = req.body as z.infer<typeof AftercareSchemas.reviewBody>;
      const review = await this.reviews.create(req.user!.id, req.params.id, body);
      return HttpResponse.created(res, presentReview(review));
    } catch (err) {
      next(err);
    }
  }

  private async dispute(req: Request, res: Response, next: NextFunction) {
    try {
      const body = req.body as z.infer<typeof AftercareSchemas.disputeBody>;
      const dispute = await this.disputes.open(req.user!.id, req.params.id, {
        reasonCode: body.reason_code,
        description: body.description,
        attachments: body.attachments,
      });
      return HttpResponse.created(res, presentDispute(dispute));
    } catch (err) {
      next(err);
    }
  }

  private async detailOf(req: Request) {
    const detail = await this.bookings.getDetail(req.user!.id, req.params.id);
    let avatarUrl: string | null = null;
    if (detail.provider) {
      const profile = await ProviderProfileModel.findById(detail.provider.id).select('userId').lean();
      const user = profile ? await UserModel.findById(profile.userId).select('avatarKey').lean() : null;
      avatarUrl = user?.avatarKey ? await this.storage.signedUrl(user.avatarKey) : null;
    }
    return presentDetail({ ...detail, avatarUrl, lang: resolveLanguage(req) });
  }
}
