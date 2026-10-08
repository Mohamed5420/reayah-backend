import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { Container } from 'typedi';
import type IBaseController from '../interfaces/base-controller.interface';
import { CheckAppStatusMiddleware, IdempotencyMiddleware } from '../../middlewares/app';
import { Auth } from '../../middlewares/auth';
import { MarketingSchemas } from '../../validations/marketing/marketing.validation';
import { type z } from '../../validations/zod';
import { presentPackage, presentSubscription } from '../../presenters/marketing.presenter';
import { defineRoute, type DefinedRoute } from '../../../docs/openapi';
import { PackageService, PromoService, ReferralService, promoDescription } from '../../../services/marketing';
import { PaymentService } from '../../../services/payments/payment.service';
import { PaymentMethod } from '../../../interfaces/IBooking';
import { UserRole } from '../../../interfaces/enums';
import { HttpResponse } from '../../../utils/response/http-response';
import { parsePagination } from '../../../utils/response/pagination';
import { resolveLanguage, t } from '../../../utils/i18n';
import { ValidationError } from '../../../utils/types-errors';

const tags = ['Patient — Packages & Promos'];
const auth = true;

const r = {
  packages: defineRoute({
    method: 'get',
    path: '/packages',
    summary:
      'Available packages. With `area_id`, only packages someone in that area can serve (a provider whose own price is at or below the per-visit value).',
    tags,
    auth,
    request: { query: MarketingSchemas.packagesQuery },
    response: { schema: MarketingSchemas.package.array() },
  }),
  package: defineRoute({
    method: 'get',
    path: '/packages/:id',
    summary: 'Package details',
    tags,
    auth,
    request: { params: MarketingSchemas.idParams },
    response: { schema: MarketingSchemas.package },
  }),
  subscribe: defineRoute({
    method: 'post',
    path: '/packages/:id/subscribe',
    summary:
      'Buy a package for one of my patient profiles — card / wallet upfront. Pay at payment_action.checkout_url; it starts once the gateway confirms.',
    tags,
    auth,
    idempotent: true,
    request: { params: MarketingSchemas.idParams, body: MarketingSchemas.subscribeBody },
    response: { status: 201, schema: MarketingSchemas.subscribed },
  }),
  mySubscriptions: defineRoute({
    method: 'get',
    path: '/me/package-subscriptions',
    summary:
      'My packages with remaining visits, newest first. Book a visit with package_subscription_id on the quote.',
    tags,
    auth,
    request: { query: MarketingSchemas.subscriptionsQuery },
    response: { schema: MarketingSchemas.subscription, paginated: true },
  }),
  validatePromo: defineRoute({
    method: 'post',
    path: '/promo-codes/validate',
    summary:
      'Check a promo code before booking. Invalid → 422 PROMO_INVALID / PROMO_EXPIRED / PROMO_LIMIT_REACHED.',
    tags,
    auth,
    request: { body: MarketingSchemas.validatePromoBody },
    response: { schema: MarketingSchemas.promoValidation },
  }),
  referral: defineRoute({
    method: 'get',
    path: '/me/referral',
    summary:
      'My referral code and stats. Both sides get referral_reward after the invited patient’s first completed visit.',
    tags: ['Me'],
    auth,
    response: { schema: MarketingSchemas.referral },
  }),
};

/** Packages, promo codes and referrals for patients (spec §7.9, §7.2 `/me/referral`). */
export default class MarketingController implements IBaseController {
  path = '/';
  router = Router();

  private packages = Container.get(PackageService);
  private promos = Container.get(PromoService);
  private referrals = Container.get(ReferralService);
  private payments = Container.get(PaymentService);

  constructor() {
    this.initializeRoutes();
  }

  initializeRoutes() {
    this.mount(r.packages, [UserRole.PATIENT], async (req, res) => {
      const q = req.query as z.infer<typeof MarketingSchemas.packagesQuery>;
      const lang = resolveLanguage(req);
      const rows = await this.packages.listAvailable({ serviceId: q.service_id, areaId: q.area_id });
      return HttpResponse.ok(
        res,
        rows.map(({ pkg, service }) => presentPackage(pkg, service, lang)),
      );
    });
    this.mount(r.package, [UserRole.PATIENT], async (req, res) => {
      const { pkg, service } = await this.packages.getAvailable(req.params.id);
      return HttpResponse.ok(res, presentPackage(pkg, service, resolveLanguage(req)));
    });
    this.router.post(
      r.subscribe.path,
      CheckAppStatusMiddleware,
      r.subscribe.validate,
      ...Auth(UserRole.PATIENT),
      IdempotencyMiddleware,
      this.handle(async (req, res) => {
        const body = req.body as z.infer<typeof MarketingSchemas.subscribeBody>;
        if (!(await this.payments.cardPaymentsEnabled())) {
          throw new ValidationError({ payment_method: ['validation.payment_method_unavailable'] });
        }
        const subscription = await this.packages.createSubscription(
          req.user!.id,
          req.params.id,
          body.patient_profile_id,
        );
        // If the gateway is unreachable the purchase still stands; retry with POST /payments/initiate.
        const payment = await this.payments
          .initiateForPackage(
            req.user!.id,
            String(subscription._id),
            body.payment_method === PaymentMethod.WALLET ? PaymentMethod.WALLET : PaymentMethod.CARD,
          )
          .catch(() => null);
        return HttpResponse.created(res, {
          subscription_id: String(subscription._id),
          travel_fee_note: t('packages.travel_fee_note', {}, resolveLanguage(req)),
          payment_action: payment?.checkoutUrl
            ? {
                payment_id: String(payment._id),
                checkout_url: payment.checkoutUrl,
                expires_at: payment.expiresAt.toISOString(),
              }
            : null,
        });
      }),
    );
    this.mount(r.mySubscriptions, [UserRole.PATIENT], async (req, res) => {
      const pagination = parsePagination(req.query);
      const { data, total } = await this.packages.mine(req.user!.id, pagination);
      const lang = resolveLanguage(req);
      return HttpResponse.paginated(
        res,
        data.map((s) => presentSubscription(s, lang)),
        pagination,
        total,
      );
    });
    this.mount(r.validatePromo, [UserRole.PATIENT], async (req, res) => {
      const body = req.body as z.infer<typeof MarketingSchemas.validatePromoBody>;
      const { promo, discount } = await this.promos.evaluate(req.user!.id, body.code, {
        serviceId: body.service_id,
        subtotal: body.subtotal,
      });
      return HttpResponse.ok(res, {
        valid: true as const,
        discount,
        description: promoDescription(promo, resolveLanguage(req)),
      });
    });
    this.mount(r.referral, [], async (req, res) => {
      const s = await this.referrals.summary(req.user!.id);
      return HttpResponse.ok(res, {
        code: s.code,
        share_url: s.shareUrl,
        invited_count: s.invitedCount,
        rewards_earned: s.rewardsEarned,
        credit_balance: s.creditBalance,
      });
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
