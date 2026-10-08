import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { Container } from 'typedi';
import type IBaseController from '../interfaces/base-controller.interface';
import { CheckAppStatusMiddleware, IdempotencyMiddleware } from '../../middlewares/app';
import { AdminGuard, Auth } from '../../middlewares/auth';
import { OrgFinanceSchemas } from '../../validations/organization/organization.validation';
import { FinanceSchemas } from '../../validations/finance/finance.validation';
import { MarketingSchemas } from '../../validations/marketing/marketing.validation';
import { type z } from '../../validations/zod';
import { presentLedgerEntry, presentPayout, presentPayoutMethod } from '../../presenters/finance.presenter';
import { presentAdminPackage } from '../../presenters/marketing.presenter';
import { localized } from '../../presenters/localize';
import { defineRoute, type DefinedRoute } from '../../../docs/openapi';
import {
  OrgReportService,
  OrganizationService,
  StatementService,
  SubscriptionService,
  type PlanInput,
} from '../../../services/organization';
import { OrgPackageService, type PackageInput } from '../../../services/marketing/package.service';
import { PayoutService } from '../../../services/payouts/payout.service';
import { CommissionService } from '../../../services/payouts/commission.service';
import { PaymentService } from '../../../services/payments/payment.service';
import { auditContextFrom } from '../../../services/audit';
import { SIGNED_URL_TTL_SECONDS } from '../../../services/storage';
import { PackageSubscriptionModel } from '../../../database/models/marketing/marketing.models';
import { PaymentMethod } from '../../../interfaces/IBooking';
import { LedgerOwnerType } from '../../../interfaces/ILedger';
import { UserRole } from '../../../interfaces/enums';
import type { IOrganization, IOrgStatement, ISubscriptionPlan } from '../../../interfaces/IOrganization';
import { HttpResponse } from '../../../utils/response/http-response';
import { parsePagination } from '../../../utils/response/pagination';
import { camelizeKeys } from '../../../utils/case';
import { cairoDate } from '../../../utils/time/cairo';
import { resolveLanguage, type Language } from '../../../utils/i18n';

const tags = ['Owner — Finance & reports'];
const auth = true;
const params = OrgFinanceSchemas.idParams;

const r = {
  dashboard: defineRoute({
    method: 'get',
    path: '/org/dashboard',
    summary:
      'KPIs for today / the last 7 days / this month, with alerts (unassigned bookings, offers, commission limit)',
    tags,
    auth,
    request: { query: OrgFinanceSchemas.dashboardQuery },
    response: { schema: OrgFinanceSchemas.dashboard },
  }),
  reports: defineRoute({
    method: 'get',
    path: '/org/reports',
    summary: 'Performance between two Cairo dates, grouped by day, staff or service',
    tags,
    auth,
    request: { query: OrgFinanceSchemas.reportQuery },
    response: { schema: OrgFinanceSchemas.report },
  }),
  invoices: defineRoute({
    method: 'get',
    path: '/org/invoices',
    summary:
      'Monthly statements of platform charges (commission + plan fees), newest first. Statements, not tax invoices.',
    tags,
    auth,
    request: { query: FinanceSchemas.pageQuery },
    response: { schema: OrgFinanceSchemas.statement, paginated: true },
  }),
  invoicePdf: defineRoute({
    method: 'get',
    path: '/org/invoices/:id/pdf',
    summary: 'The statement as an Arabic PDF (signed link, 10 minutes)',
    tags,
    auth,
    request: { params },
    response: { schema: OrgFinanceSchemas.statementPdf },
  }),
  earnings: defineRoute({
    method: 'get',
    path: '/org/earnings',
    summary:
      'Totals for a period (default: this month) + balance, payout method and commission limit — same shape as the provider’s',
    tags,
    auth,
    request: { query: FinanceSchemas.earningsQuery },
    response: { schema: FinanceSchemas.earnings },
  }),
  ledger: defineRoute({
    method: 'get',
    path: '/org/ledger',
    summary: 'Ledger entries, newest first (earnings, commission, plan fees, payouts, adjustments)',
    tags,
    auth,
    request: { query: FinanceSchemas.pageQuery },
    response: { schema: FinanceSchemas.ledgerEntry, paginated: true },
  }),
  payouts: defineRoute({
    method: 'get',
    path: '/org/payouts',
    summary: 'Payout history with statements',
    tags,
    auth,
    request: { query: FinanceSchemas.pageQuery },
    response: { schema: FinanceSchemas.payout, paginated: true },
  }),
  getMethod: defineRoute({
    method: 'get',
    path: '/org/payout-method',
    summary: 'Where payouts go (masked); null until set',
    tags,
    auth,
    response: { schema: FinanceSchemas.payoutMethod },
  }),
  setMethod: defineRoute({
    method: 'put',
    path: '/org/payout-method',
    summary: 'The organization’s bank account or wallet for payouts (stored encrypted)',
    tags,
    auth,
    request: { body: FinanceSchemas.payoutMethodBody },
    response: { schema: FinanceSchemas.payoutMethod },
  }),
  payDues: defineRoute({
    method: 'post',
    path: '/org/commission/pay',
    summary:
      'Pay commission owed on cash bookings — all or part — by card / wallet; credited when the gateway confirms (plan fees: POST /org/subscription/pay)',
    tags,
    auth,
    idempotent: true,
    request: { body: FinanceSchemas.payCommissionBody },
    response: { status: 201, schema: FinanceSchemas.commissionCheckout },
  }),
  subscription: defineRoute({
    method: 'get',
    path: '/org/subscription',
    summary: 'Current plan, paid period and staff usage',
    tags,
    auth,
    response: { schema: OrgFinanceSchemas.subscription },
  }),
  subscribe: defineRoute({
    method: 'post',
    path: '/org/subscription',
    summary:
      'Change plan now. A paid plan is charged monthly, taken from earnings (or paid in the app); the unused part of a paid month comes back.',
    tags,
    auth,
    request: { body: OrgFinanceSchemas.subscribeBody },
    response: { schema: OrgFinanceSchemas.subscription },
  }),
  payPlanFees: defineRoute({
    method: 'post',
    path: '/org/subscription/pay',
    summary:
      'Pay all unpaid plan fees by card / wallet (otherwise they’re taken from earnings). Unpaid 14 days → notice; 21 days → moved to the free plan.',
    tags,
    auth,
    idempotent: true,
    request: { body: OrgFinanceSchemas.payPlanFeesBody },
    response: { status: 201, schema: FinanceSchemas.commissionCheckout },
  }),
  plans: defineRoute({
    method: 'get',
    path: '/subscription-plans',
    summary: 'Plans for organizations',
    tags,
    auth,
    response: { schema: OrgFinanceSchemas.plan.array() },
  }),
  packages: defineRoute({
    method: 'get',
    path: '/org/packages',
    summary: 'The organization’s own packages',
    tags,
    auth,
    response: { schema: MarketingSchemas.adminPackage.array() },
  }),
  createPackage: defineRoute({
    method: 'post',
    path: '/org/packages',
    summary:
      'Create a package for a service the organization offers. Each completed visit earns the per-visit value minus commission.',
    tags,
    auth,
    request: { body: MarketingSchemas.createPackageBody },
    response: { status: 201, schema: MarketingSchemas.adminPackage },
  }),
  updatePackage: defineRoute({
    method: 'patch',
    path: '/org/packages/:id',
    summary: 'Update a package (packages already sold keep their terms)',
    tags,
    auth,
    request: { params, body: MarketingSchemas.updatePackageBody },
    response: { schema: MarketingSchemas.adminPackage },
  }),
  deletePackage: defineRoute({
    method: 'delete',
    path: '/org/packages/:id',
    summary: 'Deactivate a package',
    tags,
    auth,
    request: { params },
    response: { status: 204 },
  }),
  adminPlans: defineRoute({
    method: 'get',
    path: '/admin/subscription-plans',
    summary: 'Organization plans (incl. inactive)',
    tags: ['Admin — Organizations'],
    auth,
    response: { schema: OrgFinanceSchemas.adminPlan.array() },
  }),
  adminCreatePlan: defineRoute({
    method: 'post',
    path: '/admin/subscription-plans',
    summary: 'Create a plan (exactly one is the default free plan new organizations start on)',
    tags: ['Admin — Organizations'],
    auth,
    request: { body: OrgFinanceSchemas.createPlanBody },
    response: { status: 201, schema: OrgFinanceSchemas.adminPlan },
  }),
  adminUpdatePlan: defineRoute({
    method: 'patch',
    path: '/admin/subscription-plans/:id',
    summary: 'Update a plan (price changes apply from the next monthly renewal)',
    tags: ['Admin — Organizations'],
    auth,
    request: { params, body: OrgFinanceSchemas.updatePlanBody },
    response: { schema: OrgFinanceSchemas.adminPlan },
  }),
};

const presentPlan = (p: ISubscriptionPlan, lang: Language) => ({
  id: String(p._id),
  key: p.key,
  name: localized(p.nameAr, p.nameEn, lang),
  monthly_price: p.monthlyPrice,
  max_staff: p.maxStaff,
  features: p.features.map((f) => localized(f.ar, f.en, lang)),
  is_default: p.isDefault,
});

const presentAdminPlan = (p: ISubscriptionPlan) => ({
  id: String(p._id),
  key: p.key,
  name_ar: p.nameAr,
  name_en: p.nameEn,
  monthly_price: p.monthlyPrice,
  max_staff: p.maxStaff,
  features: p.features.map((f) => ({ ar: f.ar, en: f.en ?? null })),
  is_active: p.isActive,
  is_default: p.isDefault,
  sort_order: p.sortOrder,
});

const presentStatement = (s: IOrgStatement) => ({
  id: String(s._id),
  period: s.period,
  number: s.number,
  kind: 'statement' as const,
  visits: s.visits,
  commission: s.commission,
  subscription_fees: s.subscriptionFees,
  subscription_credits: s.subscriptionCredits,
  total: s.total,
  currency: 'EGP' as const,
  created_at: s.createdAt.toISOString(),
});

/** Owner — dashboard, reports, statements, finance, plan and packages (spec §7.11; M3.4). */
export default class OrgFinanceController implements IBaseController {
  path = '/org';
  router = Router();

  private organizations = Container.get(OrganizationService);
  private reports = Container.get(OrgReportService);
  private statements = Container.get(StatementService);
  private payouts = Container.get(PayoutService);
  private commission = Container.get(CommissionService);
  private payments = Container.get(PaymentService);
  private subscriptions = Container.get(SubscriptionService);
  private orgPackages = Container.get(OrgPackageService);

  constructor() {
    this.initializeRoutes();
  }

  initializeRoutes() {
    const owner = [UserRole.OWNER];
    const org = (req: Request) => this.organizations.getOwn(req.user!.id);
    const money = (o: IOrganization) => ({ ownerType: LedgerOwnerType.ORGANIZATION, ownerId: o._id });

    this.mount(r.dashboard, owner, async (req, res) => {
      const q = req.query as unknown as z.infer<typeof OrgFinanceSchemas.dashboardQuery>;
      return HttpResponse.ok(
        res,
        await this.reports.dashboard(await org(req), q.period, resolveLanguage(req)),
      );
    });
    this.mount(r.reports, owner, async (req, res) => {
      const q = req.query as unknown as z.infer<typeof OrgFinanceSchemas.reportQuery>;
      return HttpResponse.ok(
        res,
        await this.reports.report(
          await org(req),
          { from: q.from, to: q.to, groupBy: q.group_by },
          resolveLanguage(req),
        ),
      );
    });
    this.mount(r.invoices, owner, async (req, res) => {
      const pagination = parsePagination(req.query);
      const { data, total } = await this.statements.list((await org(req))._id, pagination);
      return HttpResponse.paginated(res, data.map(presentStatement), pagination, total);
    });
    this.mount(r.invoicePdf, owner, async (req, res) => {
      const { url } = await this.statements.pdfUrl((await org(req))._id, req.params.id);
      return HttpResponse.ok(res, { url, expires_in: SIGNED_URL_TTL_SECONDS });
    });

    this.mount(r.earnings, owner, async (req, res) => {
      const q = req.query as unknown as z.infer<typeof FinanceSchemas.earningsQuery>;
      const today = cairoDate();
      const from = q.from ?? `${today.slice(0, 8)}01`;
      const to = q.to ?? today;
      const o = await org(req);
      const e = await this.payouts.earnings(money(o), from, to);
      const limit = await this.commission.status(o._id, LedgerOwnerType.ORGANIZATION);
      return HttpResponse.ok(res, {
        period: { from, to },
        completed_visits: e.completedVisits,
        gross: e.gross,
        commission: e.commission,
        net: e.net,
        wallet_balance: e.walletBalance,
        commission_due: e.commissionDue,
        currency: 'EGP' as const,
        payout_method: presentPayoutMethod(await this.payouts.getMethod(money(o))),
        commission_limit: { max: limit.limit, warning: limit.warning, over_limit: limit.overLimit },
      });
    });
    this.mount(r.ledger, owner, async (req, res) => {
      const pagination = parsePagination(req.query);
      const { data, total } = await this.payouts.ledgerEntries(money(await org(req)), pagination);
      return HttpResponse.paginated(res, data.map(presentLedgerEntry), pagination, total);
    });
    this.mount(r.payouts, owner, async (req, res) => {
      const pagination = parsePagination(req.query);
      const { data, total } = await this.payouts.payoutsOf(money(await org(req)), pagination);
      return HttpResponse.paginated(res, data.map(presentPayout), pagination, total);
    });
    this.mount(r.getMethod, owner, async (req, res) =>
      HttpResponse.ok(res, presentPayoutMethod(await this.payouts.getMethod(money(await org(req))))),
    );
    this.mount(r.setMethod, owner, async (req, res) => {
      const body = req.body as z.infer<typeof FinanceSchemas.payoutMethodBody>;
      const method = await this.payouts.setMethod(money(await org(req)), {
        type: body.type,
        accountHolder: body.account_holder,
        bankName: body.bank_name,
        walletProvider: body.wallet_provider,
        accountNumber: body.account_number,
      });
      return HttpResponse.ok(res, presentPayoutMethod(method));
    });
    this.router.post(
      r.payDues.path,
      CheckAppStatusMiddleware,
      r.payDues.validate,
      ...Auth(UserRole.OWNER),
      IdempotencyMiddleware,
      this.wrap(async (req, res) => {
        const body = req.body as z.infer<typeof FinanceSchemas.payCommissionBody>;
        const payment = await this.payments.initiateCommissionPayment(req.user!.id, money(await org(req)), {
          amount: body.amount,
          method: body.method === 'wallet' ? PaymentMethod.WALLET : PaymentMethod.CARD,
        });
        return HttpResponse.created(res, {
          payment_id: String(payment._id),
          checkout_url: payment.checkoutUrl,
          amount: payment.amount,
          expires_at: payment.expiresAt.toISOString(),
        });
      }),
    );

    this.mount(r.subscription, owner, async (req, res) =>
      HttpResponse.ok(res, this.presentSubscription(await this.subscriptions.current(await org(req)), req)),
    );
    this.mount(r.subscribe, owner, async (req, res) => {
      const body = req.body as z.infer<typeof OrgFinanceSchemas.subscribeBody>;
      const current = await this.subscriptions.change(await org(req), body.plan_id, auditContextFrom(req));
      return HttpResponse.ok(res, this.presentSubscription(current, req));
    });
    this.router.post(
      r.payPlanFees.path,
      CheckAppStatusMiddleware,
      r.payPlanFees.validate,
      ...Auth(UserRole.OWNER),
      IdempotencyMiddleware,
      this.wrap(async (req, res) => {
        const body = req.body as z.infer<typeof OrgFinanceSchemas.payPlanFeesBody>;
        const payment = await this.payments.initiatePlanFeePayment(
          req.user!.id,
          (await org(req))._id,
          body.method === 'wallet' ? PaymentMethod.WALLET : PaymentMethod.CARD,
        );
        return HttpResponse.created(res, {
          payment_id: String(payment._id),
          checkout_url: payment.checkoutUrl,
          amount: payment.amount,
          expires_at: payment.expiresAt.toISOString(),
        });
      }),
    );
    this.mount(r.plans, [UserRole.OWNER, UserRole.ADMIN], async (req, res) =>
      HttpResponse.ok(
        res,
        (await this.subscriptions.activePlans()).map((p) => presentPlan(p, resolveLanguage(req))),
      ),
    );

    this.mount(r.packages, owner, async (req, res) => {
      const packages = await this.orgPackages.list((await org(req))._id);
      return HttpResponse.ok(res, await Promise.all(packages.map((p) => this.withSold(p))));
    });
    this.mount(r.createPackage, owner, async (req, res) => {
      const pkg = await this.orgPackages.create(await org(req), camelizeKeys(req.body) as PackageInput);
      return HttpResponse.created(res, await this.withSold(pkg));
    });
    this.mount(r.updatePackage, owner, async (req, res) => {
      const pkg = await this.orgPackages.update(
        await org(req),
        req.params.id,
        camelizeKeys(req.body) as Partial<PackageInput>,
      );
      return HttpResponse.ok(res, await this.withSold(pkg));
    });
    this.mount(r.deletePackage, owner, async (req, res) => {
      await this.orgPackages.deactivate(await org(req), req.params.id);
      return HttpResponse.noContent(res);
    });

    this.admin(r.adminPlans, async (_req, res) =>
      HttpResponse.ok(res, (await this.subscriptions.listAll()).map(presentAdminPlan)),
    );
    this.admin(r.adminCreatePlan, async (req, res) =>
      HttpResponse.created(
        res,
        presentAdminPlan(
          await this.subscriptions.create(camelizeKeys(req.body) as PlanInput, auditContextFrom(req)),
        ),
      ),
    );
    this.admin(r.adminUpdatePlan, async (req, res) =>
      HttpResponse.ok(
        res,
        presentAdminPlan(
          await this.subscriptions.update(
            req.params.id,
            camelizeKeys(req.body) as Partial<PlanInput>,
            auditContextFrom(req),
          ),
        ),
      ),
    );
  }

  private presentSubscription(current: Awaited<ReturnType<SubscriptionService['current']>>, req: Request) {
    return {
      plan: presentPlan(current.plan, resolveLanguage(req)),
      period: current.period
        ? { start: current.period.start.toISOString(), end: current.period.end.toISOString() }
        : null,
      usage: {
        staff: current.usage.staff,
        pending_invites: current.usage.pendingInvites,
        max_staff: current.plan.maxStaff,
      },
      unpaid: {
        amount: current.unpaid.amount,
        since: current.unpaid.since ? current.unpaid.since.toISOString() : null,
      },
    };
  }

  private async withSold(
    pkg: Parameters<typeof presentAdminPackage>[0] extends infer P ? Omit<P, 'soldCount'> : never,
  ) {
    const soldCount = await PackageSubscriptionModel.countDocuments({
      packageId: pkg._id,
      status: { $nin: ['pending_payment', 'cancelled'] },
    });
    return presentAdminPackage({ ...pkg, soldCount });
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
      this.wrap(handler),
    );
  }

  private admin(route: DefinedRoute, handler: (req: Request, res: Response) => Promise<unknown>) {
    this.router[route.method](
      route.path,
      CheckAppStatusMiddleware,
      route.validate,
      ...AdminGuard,
      this.wrap(handler),
    );
  }

  private wrap(handler: (req: Request, res: Response) => Promise<unknown>): RequestHandler {
    // Express 4 doesn't forward rejected promises itself.
    return (req: Request, res: Response, next: NextFunction) => {
      handler(req, res).catch(next);
    };
  }
}
