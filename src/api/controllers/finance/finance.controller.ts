import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { Container } from 'typedi';
import type IBaseController from '../interfaces/base-controller.interface';
import { CheckAppStatusMiddleware, IdempotencyMiddleware } from '../../middlewares/app';
import { AdminGuard, Auth } from '../../middlewares/auth';
import { FinanceSchemas } from '../../validations/finance/finance.validation';
import { z } from '../../validations/zod';
import { presentLedgerEntry, presentPayout, presentPayoutMethod } from '../../presenters/finance.presenter';
import { defineRoute, type DefinedRoute } from '../../../docs/openapi';
import { PayoutService } from '../../../services/payouts/payout.service';
import { ReportService } from '../../../services/reports/report.service';
import { CommissionService } from '../../../services/payouts/commission.service';
import { PaymentService } from '../../../services/payments/payment.service';
import { PaymentMethod } from '../../../interfaces/IBooking';
import { ProviderProfileService } from '../../../services/provider';
import { auditContextFrom } from '../../../services/audit';
import { UserRole } from '../../../interfaces/enums';
import { HttpResponse } from '../../../utils/response/http-response';
import { parsePagination } from '../../../utils/response/pagination';
import { cairoDate } from '../../../utils/time/cairo';
import { ValidationError } from '../../../utils/types-errors';

const auth = true;
const providerTags = ['Provider — Earnings'];
const adminTags = ['Admin — Finance'];
const params = FinanceSchemas.idParams;

const r = {
  earnings: defineRoute({
    method: 'get',
    path: '/provider/earnings',
    summary: 'Totals for a period (default: this month, Cairo dates) + current balance and payout method',
    tags: providerTags,
    auth,
    request: { query: FinanceSchemas.earningsQuery },
    response: { schema: FinanceSchemas.earnings },
  }),
  ledger: defineRoute({
    method: 'get',
    path: '/provider/ledger',
    summary: 'Ledger entries, newest first (credits, commission due, payouts, adjustments)',
    tags: providerTags,
    auth,
    request: { query: FinanceSchemas.pageQuery },
    response: { schema: FinanceSchemas.ledgerEntry, paginated: true },
  }),
  payouts: defineRoute({
    method: 'get',
    path: '/provider/payouts',
    summary: 'Payout history',
    tags: providerTags,
    auth,
    request: { query: FinanceSchemas.pageQuery },
    response: { schema: FinanceSchemas.payout, paginated: true },
  }),
  getMethod: defineRoute({
    method: 'get',
    path: '/provider/payout-method',
    summary: 'Where payouts go (masked); null until set',
    tags: providerTags,
    auth,
    response: { schema: FinanceSchemas.payoutMethod },
  }),
  setMethod: defineRoute({
    method: 'put',
    path: '/provider/payout-method',
    summary: 'Bank account or mobile wallet for payouts (stored encrypted)',
    tags: providerTags,
    auth,
    request: { body: FinanceSchemas.payoutMethodBody },
    response: { schema: FinanceSchemas.payoutMethod },
  }),

  payCommission: defineRoute({
    method: 'post',
    path: '/provider/commission/pay',
    summary:
      'Pay commission owed on cash bookings (all, or part) by card / wallet; credited when the gateway confirms. Poll GET /payments/{id}.',
    tags: providerTags,
    auth,
    idempotent: true,
    request: { body: FinanceSchemas.payCommissionBody },
    response: { status: 201, schema: FinanceSchemas.commissionCheckout },
  }),

  adminPayouts: defineRoute({
    method: 'get',
    path: '/admin/payouts',
    summary: 'Payout queue, oldest first, with full transfer details',
    tags: adminTags,
    auth,
    request: { query: FinanceSchemas.adminPayoutsQuery },
    response: { schema: FinanceSchemas.adminPayout, paginated: true },
  }),
  generate: defineRoute({
    method: 'post',
    path: '/admin/payouts/generate',
    summary:
      'Generate a payout batch now (also runs automatically on payout_day): every provider and organization at or above payout_min_amount with a payout method and no open payout',
    tags: adminTags,
    auth,
    response: { schema: FinanceSchemas.generated },
  }),
  bulkApprove: defineRoute({
    method: 'post',
    path: '/admin/payouts/bulk-approve',
    summary: 'Approve pending payouts (others are returned as skipped)',
    tags: adminTags,
    auth,
    request: { body: FinanceSchemas.bulkApproveBody },
    response: { schema: FinanceSchemas.bulkApproved },
  }),
  markPaid: defineRoute({
    method: 'post',
    path: '/admin/payouts/:id/mark-paid',
    summary: 'Record the transfer reference for an approved payout; the provider is notified',
    tags: adminTags,
    auth,
    request: { params, body: FinanceSchemas.markPaidBody },
    response: { schema: FinanceSchemas.payout },
  }),
  cancel: defineRoute({
    method: 'post',
    path: '/admin/payouts/:id/cancel',
    summary: 'Cancel a pending / approved payout (e.g. wrong account); the amount returns to the balance',
    tags: adminTags,
    auth,
    request: { params, body: FinanceSchemas.cancelBody },
    response: { schema: FinanceSchemas.payout },
  }),
  commissionDues: defineRoute({
    method: 'get',
    path: '/admin/commission-dues',
    summary: 'Providers and organizations owing the platform (cash commission, plan fees), most owed first',
    tags: adminTags,
    auth,
    request: { query: FinanceSchemas.pageQuery },
    response: { schema: FinanceSchemas.commissionDue, paginated: true },
  }),
  adjustment: defineRoute({
    method: 'post',
    path: '/admin/ledger/adjustment',
    summary: 'Manual ledger credit (+) or debit (−) with a reason. Audited.',
    tags: adminTags,
    auth,
    request: { body: FinanceSchemas.adjustmentBody },
    response: { status: 201, schema: FinanceSchemas.ledgerEntry },
  }),
  export: defineRoute({
    method: 'get',
    path: '/admin/reports/export',
    summary:
      'CSV export of bookings, payments or payouts created in [from, to] (Cairo dates). No names or medical data.',
    tags: adminTags,
    auth,
    request: { query: FinanceSchemas.exportQuery },
    response: { description: 'text/csv file', schema: z.string() },
  }),
};

/** Provider earnings / payouts (spec §7.10) and admin finance (spec §7.15). Independent providers only. */
export default class FinanceController implements IBaseController {
  path = '/';
  router = Router();

  private payouts = Container.get(PayoutService);
  private reports = Container.get(ReportService);
  private profiles = Container.get(ProviderProfileService);
  private commission = Container.get(CommissionService);
  private payments = Container.get(PaymentService);

  constructor() {
    this.initializeRoutes();
  }

  initializeRoutes() {
    // Provider (staff have no payouts screen — spec §7.10).
    const provider = [UserRole.PROVIDER];
    this.mount(r.earnings, provider, async (req, res) => {
      const q = req.query as unknown as z.infer<typeof FinanceSchemas.earningsQuery>;
      const today = cairoDate();
      const from = q.from ?? `${today.slice(0, 8)}01`;
      const to = q.to ?? today;
      if (to < from) throw new ValidationError({ to: ['validation.ends_before_starts'] });
      if (Math.round((Date.parse(to) - Date.parse(from)) / 864e5) + 1 > 366) {
        throw new ValidationError({ to: ['validation.range_too_long'] });
      }
      const profile = await this.profiles.getOwn(req.user!.id);
      const [e, daily, next] = await Promise.all([
        this.payouts.earnings(profile._id, from, to),
        this.payouts.dailyEarnings(profile._id, from, to),
        this.payouts.nextPayout(profile._id),
      ]);
      return HttpResponse.ok(res, {
        period: { from, to },
        completed_visits: e.completedVisits,
        gross: e.gross,
        commission: e.commission,
        net: e.net,
        wallet_balance: e.walletBalance,
        commission_due: e.commissionDue,
        currency: 'EGP' as const,
        payout_method: presentPayoutMethod(await this.payouts.getMethod(profile._id)),
        commission_limit: await this.commission.status(profile._id).then((s) => ({
          max: s.limit,
          warning: s.warning,
          over_limit: s.overLimit,
        })),
        cash_collected: daily.cashCollected,
        days: daily.days.map((d) => ({ date: d.date, completed_visits: d.completedVisits, net: d.net })),
        next_payout: {
          date: next.date,
          amount: next.amount,
          minimum_amount: next.minimumAmount,
          eligible: next.eligible,
          reason: next.reason,
        },
      });
    });
    this.mount(r.ledger, provider, async (req, res) => {
      const pagination = parsePagination(req.query);
      const profile = await this.profiles.getOwn(req.user!.id);
      const { data, total } = await this.payouts.ledgerEntries(profile._id, pagination);
      return HttpResponse.paginated(res, data.map(presentLedgerEntry), pagination, total);
    });
    this.mount(r.payouts, provider, async (req, res) => {
      const pagination = parsePagination(req.query);
      const profile = await this.profiles.getOwn(req.user!.id);
      const { data, total } = await this.payouts.payoutsOf(profile._id, pagination);
      return HttpResponse.paginated(res, data.map(presentPayout), pagination, total);
    });
    this.mount(r.getMethod, provider, async (req, res) => {
      const profile = await this.profiles.getOwn(req.user!.id);
      return HttpResponse.ok(res, presentPayoutMethod(await this.payouts.getMethod(profile._id)));
    });
    this.mount(r.setMethod, provider, async (req, res) => {
      const body = req.body as z.infer<typeof FinanceSchemas.payoutMethodBody>;
      const profile = await this.profiles.getOwn(req.user!.id);
      const method = await this.payouts.setMethod(profile._id, {
        type: body.type,
        accountHolder: body.account_holder,
        bankName: body.bank_name,
        walletProvider: body.wallet_provider,
        accountNumber: body.account_number,
      });
      return HttpResponse.ok(res, presentPayoutMethod(method));
    });

    this.router.post(
      r.payCommission.path,
      CheckAppStatusMiddleware,
      r.payCommission.validate,
      ...Auth(UserRole.PROVIDER),
      IdempotencyMiddleware,
      this.wrap(async (req, res) => {
        const body = req.body as z.infer<typeof FinanceSchemas.payCommissionBody>;
        const profile = await this.profiles.getOwn(req.user!.id);
        const payment = await this.payments.initiateCommissionPayment(req.user!.id, profile._id, {
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

    // Admin.
    this.admin(r.adminPayouts, async (req, res) => {
      const q = req.query as unknown as z.infer<typeof FinanceSchemas.adminPayoutsQuery>;
      const pagination = parsePagination(req.query);
      const { data, total } = await this.payouts.adminList({ status: q.status }, pagination);
      return HttpResponse.paginated(
        res,
        data.map((row) => ({
          ...presentPayout(row.payout),
          owner_type: row.ownerType,
          provider: row.provider,
          organization: row.organization,
          destination_details: row.destination,
        })),
        pagination,
        total,
      );
    });
    this.admin(r.generate, async (req, res) => {
      const created = await this.payouts.generateBatch(auditContextFrom(req));
      return HttpResponse.ok(res, {
        created: created.length,
        total: created.reduce((sum, p) => sum + p.amount, 0),
      });
    });
    this.admin(r.bulkApprove, async (req, res) => {
      const body = req.body as z.infer<typeof FinanceSchemas.bulkApproveBody>;
      return HttpResponse.ok(res, await this.payouts.approve(body.payout_ids, auditContextFrom(req)));
    });
    this.admin(r.markPaid, async (req, res) => {
      const body = req.body as z.infer<typeof FinanceSchemas.markPaidBody>;
      return HttpResponse.ok(
        res,
        presentPayout(await this.payouts.markPaid(req.params.id, body.reference, auditContextFrom(req))),
      );
    });
    this.admin(r.cancel, async (req, res) => {
      const body = req.body as z.infer<typeof FinanceSchemas.cancelBody>;
      return HttpResponse.ok(
        res,
        presentPayout(await this.payouts.cancel(req.params.id, body.reason, auditContextFrom(req))),
      );
    });
    this.admin(r.commissionDues, async (req, res) => {
      const pagination = parsePagination(req.query);
      const { data, total } = await this.payouts.commissionDues(pagination);
      const limit = await this.commission.limit();
      return HttpResponse.paginated(
        res,
        // Most owed first, so providers over the limit are at the top.
        data.map((row) => ({
          owner_type: row.ownerType,
          provider: row.provider,
          organization: row.organization,
          amount_due: -row.wallet.balance,
          over_limit: -row.wallet.balance > limit,
          updated_at: row.wallet.updatedAt.toISOString(),
        })),
        pagination,
        total,
      );
    });
    this.admin(r.adjustment, async (req, res) => {
      const body = req.body as z.infer<typeof FinanceSchemas.adjustmentBody>;
      const entry = await this.payouts.adjust(
        { ownerType: body.owner_type, ownerId: body.owner_id, amount: body.amount, reason: body.reason },
        auditContextFrom(req),
      );
      return HttpResponse.created(res, presentLedgerEntry(entry));
    });
    this.admin(r.export, async (req, res) => {
      const q = req.query as unknown as z.infer<typeof FinanceSchemas.exportQuery>;
      const { csv, filename } = await this.reports.export(q.type, q.from, q.to, auditContextFrom(req));
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).send(csv);
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
