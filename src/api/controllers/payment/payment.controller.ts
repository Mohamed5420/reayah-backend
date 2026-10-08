import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { Container } from 'typedi';
import type IBaseController from '../interfaces/base-controller.interface';
import { CheckAppStatusMiddleware, IdempotencyMiddleware } from '../../middlewares/app';
import { AdminGuard, Auth } from '../../middlewares/auth';
import { PaymentSchemas } from '../../validations/payment/payment.validation';
import { type z } from '../../validations/zod';
import { presentPayment, presentRefund } from '../../presenters/payment.presenter';
import { defineRoute, type DefinedRoute } from '../../../docs/openapi';
import { PaymentService } from '../../../services/payments/payment.service';
import { auditContextFrom } from '../../../services/audit';
import { env } from '../../../config/env.config';
import { UserRole } from '../../../interfaces/enums';
import { HttpResponse } from '../../../utils/response/http-response';
import { parsePagination } from '../../../utils/response/pagination';

const tags = ['Payments'];
const auth = true;
const params = PaymentSchemas.idParams;

const r = {
  initiate: defineRoute({
    method: 'post',
    path: '/payments/initiate',
    summary:
      'Start a card / wallet checkout for my unpaid booking (also returned by POST /bookings). Open checkout_url; the result arrives by webhook.',
    tags,
    auth,
    idempotent: true,
    request: { body: PaymentSchemas.initiateBody },
    response: { schema: PaymentSchemas.initiated },
  }),
  get: defineRoute({
    method: 'get',
    path: '/payments/:id',
    summary: 'Payment status — poll after returning from the checkout (the webhook decides "paid")',
    tags,
    auth,
    request: { params },
    response: { schema: PaymentSchemas.payment },
  }),
  mine: defineRoute({
    method: 'get',
    path: '/me/payments',
    summary: 'My payments, newest first (receipts)',
    tags,
    auth,
    request: { query: PaymentSchemas.listQuery },
    response: { schema: PaymentSchemas.payment, paginated: true },
  }),
  return: defineRoute({
    method: 'get',
    path: '/payments/:id/return',
    summary:
      "The checkout's return URL: redirects the browser back into the app (reaya://payment-result?payment_id=…)",
    tags,
    request: { params },
    response: { status: 204, description: '302 redirect to the app' },
  }),
  webhook: defineRoute({
    method: 'post',
    path: '/webhooks/payments/:gateway',
    summary: 'Gateway callback (signature-verified, idempotent). Not for apps.',
    tags,
    request: { params: PaymentSchemas.gatewayParams },
    response: { schema: PaymentSchemas.webhookResult },
  }),
  adminList: defineRoute({
    method: 'get',
    path: '/admin/payments',
    summary: 'All payments, newest first',
    tags: ['Admin — Finance'],
    auth,
    request: { query: PaymentSchemas.adminListQuery },
    response: { schema: PaymentSchemas.payment, paginated: true },
  }),
  refund: defineRoute({
    method: 'post',
    path: '/admin/bookings/:id/refund',
    summary: "Refund (part of) a booking's card / wallet payment through the gateway. Audited.",
    tags: ['Admin — Finance'],
    auth,
    request: { params, body: PaymentSchemas.refundBody },
    response: { status: 201, schema: PaymentSchemas.refund },
  }),
};

/** Card and wallet payments (spec §7.14) + the admin finance basics that depend on them. */
export default class PaymentController implements IBaseController {
  path = '/';
  router = Router();

  private payments = Container.get(PaymentService);

  constructor() {
    this.initializeRoutes();
  }

  initializeRoutes() {
    this.router.post(
      r.initiate.path,
      CheckAppStatusMiddleware,
      r.initiate.validate,
      ...Auth(UserRole.PATIENT),
      IdempotencyMiddleware,
      this.handle(async (req, res) => {
        const body = req.body as z.infer<typeof PaymentSchemas.initiateBody>;
        const payment = await this.payments.initiateForBooking(req.user!.id, body.reference_id, body.method);
        return HttpResponse.ok(res, {
          payment_id: String(payment._id),
          checkout_url: payment.checkoutUrl,
          expires_at: payment.expiresAt.toISOString(),
        });
      }),
    );
    this.mount(r.get, [UserRole.PATIENT], async (req, res) =>
      HttpResponse.ok(res, presentPayment(await this.payments.get(req.user!.id, req.params.id))),
    );
    this.mount(r.mine, [UserRole.PATIENT], async (req, res) => {
      const pagination = parsePagination(req.query);
      const { data, total } = await this.payments.listMine(req.user!.id, pagination);
      return HttpResponse.paginated(res, data.map(presentPayment), pagination, total);
    });

    // Public: the customer's browser coming back from the gateway. Never trusted for the result.
    this.router.get(r.return.path, r.return.validate, (req: Request, res: Response) => {
      const target = new URL(env.payments.appReturnUrl);
      target.searchParams.set('payment_id', req.params.id);
      res.redirect(302, target.toString());
    });
    // Public: the gateway's server-to-server callback, authenticated by its signature.
    this.router.post(
      r.webhook.path,
      r.webhook.validate,
      this.handle(async (req, res) => {
        await this.payments.handleWebhook(req.params.gateway, {
          query: req.query as Record<string, unknown>,
          body: req.body as unknown,
          headers: req.headers,
        });
        return HttpResponse.ok(res, { received: true as const });
      }),
    );

    this.router.get(
      r.adminList.path,
      CheckAppStatusMiddleware,
      r.adminList.validate,
      ...AdminGuard,
      this.handle(async (req, res) => {
        const q = req.query as unknown as z.infer<typeof PaymentSchemas.adminListQuery>;
        const pagination = parsePagination(req.query);
        const { data, total } = await this.payments.adminList(
          { status: q.status, method: q.method },
          pagination,
        );
        return HttpResponse.paginated(res, data.map(presentPayment), pagination, total);
      }),
    );
    this.router.post(
      r.refund.path,
      CheckAppStatusMiddleware,
      r.refund.validate,
      ...AdminGuard,
      this.handle(async (req, res) => {
        const body = req.body as z.infer<typeof PaymentSchemas.refundBody>;
        const refund = await this.payments.refundBooking(
          req.params.id,
          { amount: body.amount ?? null, reason: body.reason },
          auditContextFrom(req),
        );
        return HttpResponse.created(res, presentRefund(refund));
      }),
    );
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
