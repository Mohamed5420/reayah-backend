import { Container, Service } from 'typedi';
import { Types, type ClientSession } from 'mongoose';
import {
  OrganizationModel,
  PlanChargeModel,
  StaffInviteModel,
  SubscriptionPlanModel,
} from '../../database/models/organization/organization.models';
import { WalletBalanceModel } from '../../database/models/ledger/wallet.model';
import { NotificationType } from '../../interfaces/INotification';
import { NotificationService } from '../notification/notification.service';
import { SettingsService } from '../settings/settings.service';
import { ProviderProfileModel } from '../../database/models/provider/provider-profile.model';
import { withTransaction } from '../../database/transaction';
import { LedgerEntryType, LedgerOwnerType } from '../../interfaces/ILedger';
import {
  StaffInviteStatus,
  type IOrganization,
  type ISubscriptionPlan,
} from '../../interfaces/IOrganization';
import { logger } from '../../utils/logger/winston';
import { cairoDate } from '../../utils/time/cairo';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/types-errors';
import { AuditService, applyPatch, type AuditContext } from '../audit/audit.service';
import { LedgerService } from '../ledger/ledger.service';

/** One month later (same day of month; JavaScript rolls over e.g. 31 Jan → 3 Mar). */
const addMonth = (date: Date) => {
  const next = new Date(date);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return next;
};

/**
 * Organization plans (spec §4.7, §7.11 subscription; M3.4). Decisions: the free default plan lets a new
 * organization start without paying; a paid plan is charged monthly as a plan charge (`org_plan_charges`),
 * kept apart from the earnings balance so it never counts toward the cash-commission limit and never
 * pauses bookings. A charge is settled from the organization's available earnings (daily, and before every
 * payout — only then is it a ledger entry) or paid in the app. Unpaid after `plan_fee_notice_days` → the
 * owner is told; after `plan_fee_downgrade_days` → moved to the free plan (the fee stays owed). Changing
 * plan starts a new period at once; the unused part of a paid month comes off what's still owed, or back
 * to the balance. Over `max_staff` existing staff keep working; only new invites / joins are refused.
 */
@Service()
export class SubscriptionService {
  private readonly ledger = Container.get(LedgerService);
  private readonly audit = Container.get(AuditService);
  private readonly settings = Container.get(SettingsService);

  activePlans() {
    return SubscriptionPlanModel.find({ isActive: true }).sort({ sortOrder: 1, monthlyPrice: 1 }).lean();
  }

  async defaultPlan() {
    const plan =
      (await SubscriptionPlanModel.findOne({ isDefault: true, isActive: true }).lean()) ??
      (await SubscriptionPlanModel.findOne({ isActive: true }).sort({ monthlyPrice: 1 }).lean());
    if (!plan) throw new NotFoundError('errors.plan_not_found');
    return plan;
  }

  async planOf(org: Pick<IOrganization, 'subscriptionPlanId'>) {
    const chosen = org.subscriptionPlanId
      ? await SubscriptionPlanModel.findById(org.subscriptionPlanId).setOptions({ withDeleted: true }).lean()
      : null;
    return chosen ?? this.defaultPlan();
  }

  /** Current members and open invites (the staff limit counts both). */
  async usage(orgId: Types.ObjectId) {
    const [staff, pendingInvites] = await Promise.all([
      ProviderProfileModel.countDocuments({ organizationId: orgId }),
      StaffInviteModel.countDocuments({
        organizationId: orgId,
        status: StaffInviteStatus.PENDING,
        expiresAt: { $gt: new Date() },
      }),
    ]);
    return { staff, pendingInvites };
  }

  async current(org: IOrganization) {
    const [plan, usage, unpaid] = await Promise.all([
      this.planOf(org),
      this.usage(org._id),
      this.unpaid(org._id),
    ]);
    return { plan, period: org.subscriptionPeriod ?? null, usage, unpaid };
  }

  /** Plan fees still owed: total and since when. */
  async unpaid(orgId: Types.ObjectId) {
    const charges = await PlanChargeModel.find({ organizationId: orgId, remaining: { $gt: 0 } })
      .sort({ chargedAt: 1 })
      .lean();
    return {
      amount: charges.reduce((total, c) => total + c.remaining, 0),
      since: charges[0]?.chargedAt ?? null,
    };
  }

  /** Before an invite or a join: refused once members + open invites reach the plan's `max_staff`. */
  async assertCanAddStaff(orgId: Types.ObjectId, countingInvites = true) {
    const org = await OrganizationModel.findById(orgId).select('subscriptionPlanId').lean();
    if (!org) return;
    const [plan, usage] = await Promise.all([this.planOf(org), this.usage(orgId)]);
    const used = usage.staff + (countingInvites ? usage.pendingInvites : 0);
    if (used >= plan.maxStaff) {
      throw new ConflictError('errors.plan_staff_limit', { max: plan.maxStaff });
    }
  }

  /** POST /org/subscription — switch plan now. */
  async change(org: IOrganization, planId: string, context: AuditContext, now = new Date()) {
    const plan = Types.ObjectId.isValid(planId)
      ? await SubscriptionPlanModel.findOne({ _id: planId, isActive: true }).lean()
      : null;
    if (!plan) throw new NotFoundError('errors.plan_not_found');
    const currentPlan = await this.planOf(org);
    if (currentPlan._id.equals(plan._id)) throw new ConflictError('errors.plan_already_current');

    await withTransaction(async (session) => {
      // The unused part of a paid month: first off what's still owed for it, the rest back to the balance.
      const period = org.subscriptionPeriod;
      if (period && currentPlan.monthlyPrice > 0 && period.end > now) {
        const unused = Math.round(
          (currentPlan.monthlyPrice * (period.end.getTime() - now.getTime())) /
            (period.end.getTime() - period.start.getTime()),
        );
        const charge = await PlanChargeModel.findOne({
          organizationId: org._id,
          periodStart: period.start,
        }).session(session);
        const offOwed = Math.min(unused, charge?.remaining ?? 0);
        if (charge && offOwed > 0) {
          charge.remaining -= offOwed;
          charge.credited += offOwed;
          charge.creditedAt = now;
          if (charge.remaining === 0) charge.settledAt = now;
          await charge.save({ session });
        }
        if (unused - offOwed > 0) {
          await this.entry(
            session,
            org._id,
            LedgerEntryType.SUBSCRIPTION_CREDIT,
            unused - offOwed,
            `${currentPlan.key} unused`,
          );
        }
      }
      const nextPeriod = plan.monthlyPrice > 0 ? { start: now, end: addMonth(now) } : null;
      if (nextPeriod) await this.charge(session, org._id, plan, nextPeriod, now);
      await OrganizationModel.updateOne(
        { _id: org._id },
        { subscriptionPlanId: plan._id, subscriptionPeriod: nextPeriod },
        { session },
      );
      await this.settle(session, org._id, now);
    });
    await this.audit.log(context, {
      action: 'organization.change_plan',
      entityType: 'organization',
      entityId: String(org._id),
      metadata: { from: currentPlan.key, to: plan.key },
    });
    return this.current((await OrganizationModel.findById(org._id).lean())!);
  }

  /**
   * Daily: paid periods that ended are renewed — another month's charge. A plan the admin made free stops
   * billing. Each renewal is claimed by its period end, so it runs once.
   */
  async billDue(now = new Date()) {
    const due = await OrganizationModel.find({ 'subscriptionPeriod.end': { $lte: now } })
      .select('subscriptionPlanId subscriptionPeriod')
      .lean();
    let billed = 0;
    for (const org of due) {
      try {
        const plan = await this.planOf(org);
        const end = org.subscriptionPeriod!.end;
        await withTransaction(async (session) => {
          const next = plan.monthlyPrice > 0 ? { start: end, end: addMonth(end) } : null;
          const claimed = await OrganizationModel.updateOne(
            { _id: org._id, 'subscriptionPeriod.end': end },
            { subscriptionPeriod: next },
            { session },
          );
          if (!claimed.modifiedCount || !next) return;
          await this.charge(session, org._id, plan, next, now);
          await this.settle(session, org._id, now);
          billed++;
        });
      } catch (err) {
        logger.error(`Plan billing failed for organization ${String(org._id)}`, err);
      }
    }
    return billed;
  }

  /**
   * Takes what's owed from the organization's available (positive) balance, oldest charge first — this is
   * the "netted from earnings" part, recorded as `subscription_fee` ledger entries. Never pushes the
   * balance below zero. Called on charge, daily, and before each payout.
   */
  async settle(session: ClientSession, orgId: Types.ObjectId, now = new Date()) {
    const charges = await PlanChargeModel.find({ organizationId: orgId, remaining: { $gt: 0 } })
      .sort({ chargedAt: 1 })
      .session(session);
    if (!charges.length) return 0;
    const wallet = await WalletBalanceModel.findOne({
      ownerType: LedgerOwnerType.ORGANIZATION,
      ownerId: orgId,
    })
      .session(session)
      .lean();
    let available = Math.max(wallet?.balance ?? 0, 0);
    let taken = 0;
    for (const charge of charges) {
      if (available <= 0) break;
      const take = Math.min(charge.remaining, available);
      await this.entry(
        session,
        orgId,
        LedgerEntryType.SUBSCRIPTION_FEE,
        -take,
        `${charge.planKey} ${cairoDate(charge.periodStart)}`,
      );
      charge.remaining -= take;
      if (charge.remaining === 0) charge.settledAt = now;
      await charge.save({ session });
      available -= take;
      taken += take;
    }
    return taken;
  }

  /** A plan-fee payment made in the app: settles charges oldest first (the money went straight to the platform). */
  async settleFromPayment(session: ClientSession, orgId: Types.ObjectId, amount: number, now = new Date()) {
    const charges = await PlanChargeModel.find({ organizationId: orgId, remaining: { $gt: 0 } })
      .sort({ chargedAt: 1 })
      .session(session);
    let left = amount;
    for (const charge of charges) {
      if (left <= 0) break;
      const take = Math.min(charge.remaining, left);
      charge.remaining -= take;
      if (charge.remaining === 0) charge.settledAt = now;
      await charge.save({ session });
      left -= take;
    }
    return amount - left;
  }

  /**
   * Daily: settle what earnings allow, then unpaid charges past `plan_fee_notice_days` → the owner is
   * told (once); past `plan_fee_downgrade_days` → moved to the free default plan (once; the fee stays owed).
   */
  async processUnpaid(now = new Date()) {
    const owing = await PlanChargeModel.distinct('organizationId', { remaining: { $gt: 0 } });
    for (const orgId of owing as Types.ObjectId[]) {
      await withTransaction((session) => this.settle(session, orgId, now)).catch((err: unknown) =>
        logger.error(`Plan fee settlement failed for ${String(orgId)}`, err),
      );
    }
    const [noticeDays, downgradeDays] = await Promise.all([
      this.settings.get('plan_fee_notice_days'),
      this.settings.get('plan_fee_downgrade_days'),
    ]);
    const days = (n: number) => new Date(now.getTime() - n * 864e5);

    const toDowngrade = await PlanChargeModel.find({
      remaining: { $gt: 0 },
      downgradedAt: null,
      chargedAt: { $lte: days(downgradeDays) },
    }).lean();
    const downgraded = new Set<string>();
    for (const charge of toDowngrade) {
      const claimed = await PlanChargeModel.updateMany(
        { organizationId: charge.organizationId, remaining: { $gt: 0 }, downgradedAt: null },
        { downgradedAt: now, overdueNoticeAt: now },
      );
      if (!claimed.modifiedCount || downgraded.has(String(charge.organizationId))) continue;
      downgraded.add(String(charge.organizationId));
      const free = await this.defaultPlan();
      await OrganizationModel.updateOne(
        { _id: charge.organizationId },
        { subscriptionPlanId: free._id, subscriptionPeriod: null },
      );
      await this.notifyOwner(charge.organizationId, 'plan_downgraded', { plan: free.nameAr });
    }

    const toNotice = await PlanChargeModel.find({
      remaining: { $gt: 0 },
      overdueNoticeAt: null,
      chargedAt: { $lte: days(noticeDays) },
    }).lean();
    for (const charge of toNotice) {
      const claimed = await PlanChargeModel.updateOne(
        { _id: charge._id, overdueNoticeAt: null },
        { overdueNoticeAt: now },
      );
      if (!claimed.modifiedCount) continue;
      await this.notifyOwner(charge.organizationId, 'plan_fee_overdue', {
        amount: (charge.remaining / 100).toFixed(2),
        days: downgradeDays - noticeDays,
      });
    }
    return { downgraded: downgraded.size, noticed: toNotice.length };
  }

  private async charge(
    session: ClientSession,
    orgId: Types.ObjectId,
    plan: ISubscriptionPlan,
    period: { start: Date; end: Date },
    now: Date,
  ) {
    await PlanChargeModel.create(
      [
        {
          organizationId: orgId,
          planId: plan._id,
          planKey: plan.key,
          amount: plan.monthlyPrice,
          remaining: plan.monthlyPrice,
          periodStart: period.start,
          periodEnd: period.end,
          chargedAt: now,
        },
      ],
      { session },
    );
  }

  private async notifyOwner(
    orgId: Types.ObjectId,
    template: 'plan_fee_overdue' | 'plan_downgraded',
    params: Record<string, string | number>,
  ) {
    const org = await OrganizationModel.findById(orgId).select('ownerUserId').lean();
    if (!org) return;
    await Container.get(NotificationService)
      .notify([org.ownerUserId], {
        type: NotificationType.ACCOUNT,
        template,
        params,
        data: { organization_id: String(orgId) },
      })
      .catch((err: unknown) => logger.error(`Plan notice ${template} failed for ${String(orgId)}`, err));
  }

  // ── Admin (spec §7.15 /admin/subscription-plans) ──

  listAll() {
    return SubscriptionPlanModel.find().sort({ sortOrder: 1, monthlyPrice: 1 }).lean();
  }

  async create(input: PlanInput, context: AuditContext) {
    const plan = await SubscriptionPlanModel.create(input);
    if (input.isDefault) await this.makeOnlyDefault(plan._id);
    await this.audit.log(context, {
      action: 'subscription_plan.create',
      entityType: 'subscription_plan',
      entityId: String(plan._id),
      metadata: { input },
    });
    return plan.toObject();
  }

  async update(id: string, patch: Partial<PlanInput>, context: AuditContext) {
    const plan = Types.ObjectId.isValid(id) ? await SubscriptionPlanModel.findById(id) : null;
    if (!plan) throw new NotFoundError('errors.plan_not_found');
    if (patch.isDefault === false && plan.isDefault) {
      throw new ValidationError({ is_default: ['validation.plan_default_required'] });
    }
    const changes = applyPatch(plan, patch);
    if (Object.keys(changes).length) {
      await plan.save();
      if (patch.isDefault) await this.makeOnlyDefault(plan._id);
      await this.audit.log(context, {
        action: 'subscription_plan.update',
        entityType: 'subscription_plan',
        entityId: id,
        metadata: { changes },
      });
    }
    return plan.toObject();
  }

  private async makeOnlyDefault(planId: Types.ObjectId) {
    await SubscriptionPlanModel.updateMany({ _id: { $ne: planId }, isDefault: true }, { isDefault: false });
  }

  private entry(
    session: ClientSession,
    orgId: Types.ObjectId,
    type: LedgerEntryType,
    amount: number,
    note: string,
  ) {
    return this.ledger.record(
      {
        ownerType: LedgerOwnerType.ORGANIZATION,
        ownerId: orgId,
        bookingId: null,
        type,
        amount,
        note: `plan ${note}`,
      },
      session,
    );
  }
}

export type PlanInput = {
  key: string;
  nameAr: string;
  nameEn?: string | null;
  monthlyPrice: number;
  maxStaff: number;
  features?: Array<{ ar: string; en: string | null }>;
  isActive?: boolean;
  isDefault?: boolean;
  sortOrder?: number;
};

export type { ISubscriptionPlan };
