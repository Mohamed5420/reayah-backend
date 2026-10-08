import { Container, Service } from 'typedi';
import { Types, type FilterQuery } from 'mongoose';
import { BroadcastModel } from '../../database/models/marketing/marketing.models';
import { UserModel } from '../../database/models/user/user.model';
import { AddressModel } from '../../database/models/patient/address.model';
import { ProviderProfileModel } from '../../database/models/provider/provider-profile.model';
import { OrganizationModel } from '../../database/models/organization/organization.models';
import { AdminRole, UserRole, UserStatus } from '../../interfaces/enums';
import type { IUser } from '../../interfaces/IUser';
import { NotificationType } from '../../interfaces/INotification';
import { BroadcastStatus, BroadcastType, type IBroadcastSegment } from '../../interfaces/IMarketing';
import { AuditService, type AuditContext } from '../audit';
import { SettingsService } from '../settings/settings.service';
import { NotificationService } from '../notification/notification.service';
import { ConflictError, ForbiddenError } from '../../utils/types-errors';
import { cairoDate } from '../../utils/time/cairo';
import { logger } from '../../utils/logger/winston';
import type { Pagination } from '../../utils/response/pagination';

const BATCH = 500;
const LEASE_MS = 5 * 60_000;
/** The maintenance worker runs one job at a time: a run stops after this long and the next one resumes. */
const RUN_BUDGET_MS = 20_000;
const AUDIENCE_ROLES = [UserRole.PATIENT, UserRole.PROVIDER, UserRole.PROVIDER_STAFF, UserRole.OWNER];

export type BroadcastInput = {
  type: BroadcastType;
  title: string;
  body: string;
  reason: string | null;
  segment: { role: IBroadcastSegment['role']; areaIds: string[] };
};

/**
 * Admin broadcasts (spec §7.15 `/admin/notifications/broadcast`; decision M3.5). Two types:
 * - marketing (default; super_admin + marketing): a `promo` notification — in-app for everyone in the
 *   segment, pushed only to those with promotions on; `broadcast_marketing_daily_max` per Cairo day.
 * - announcement (super_admin only, reason required): maintenance / policy / important updates, always
 *   pushed; `broadcast_announcement_daily_max` per day. Never for offers.
 * Both skip suspended and deleted accounts and admins, are audited, and can be previewed (audience size).
 * Sending happens in the BROADCASTS maintenance job, in batches that resume after a crash. Each recipient
 * gets it at most once: the notification carries `dedupeKey: broadcast:<id>` (unique per user), so a resumed
 * batch skips who already has it.
 */
@Service()
export class BroadcastService {
  private readonly audit = Container.get(AuditService);
  private readonly settings = Container.get(SettingsService);

  /** Audience sizes without sending: everyone in the segment, and how many get the push. */
  async preview(input: BroadcastInput) {
    const filter = await this.audienceFilter(input.segment);
    const [audience, push] = await Promise.all([
      UserModel.countDocuments(filter),
      input.type === BroadcastType.MARKETING
        ? UserModel.countDocuments({ ...filter, 'notificationSettings.promotions': { $ne: false } })
        : null,
    ]);
    return { audience, pushAudience: push ?? audience };
  }

  async create(input: BroadcastInput, adminRole: AdminRole | null | undefined, context: AuditContext) {
    if (input.type === BroadcastType.ANNOUNCEMENT && adminRole !== AdminRole.SUPER_ADMIN) {
      throw new ForbiddenError('errors.admin_permission');
    }
    const { audience } = await this.preview(input);
    if (!audience) throw new ConflictError('errors.broadcast_no_audience');

    const max = await this.settings.get(
      input.type === BroadcastType.MARKETING
        ? 'broadcast_marketing_daily_max'
        : 'broadcast_announcement_daily_max',
    );
    const day = cairoDate();
    // The (type, day, seq) unique index makes the cap hold when two admins send at once.
    for (let attempt = 0; attempt < 3; attempt++) {
      const sent = await BroadcastModel.countDocuments({ type: input.type, day }).setOptions({
        withDeleted: true,
      });
      if (sent >= max) throw new ConflictError('errors.broadcast_daily_limit', { max });
      try {
        const broadcast = await BroadcastModel.create({
          type: input.type,
          title: input.title,
          body: input.body,
          reason: input.type === BroadcastType.ANNOUNCEMENT ? input.reason : null,
          segment: {
            role: input.segment.role,
            areaIds: input.segment.areaIds.map((id) => new Types.ObjectId(id)),
          },
          createdBy: context.actorId,
          day,
          seq: sent + 1,
          audience,
        });
        await this.audit.log(context, {
          action: 'broadcast.create',
          entityType: 'broadcast',
          entityId: String(broadcast._id),
          metadata: { type: input.type, segment: input.segment, reason: broadcast.reason, audience },
        });
        return broadcast.toObject();
      } catch (err) {
        if ((err as { code?: number }).code !== 11000) throw err;
      }
    }
    throw new ConflictError('errors.broadcast_daily_limit', { max });
  }

  async list(pagination: Pagination) {
    const [data, total] = await Promise.all([
      BroadcastModel.find().sort({ createdAt: -1 }).skip(pagination.skip).limit(pagination.perPage).lean(),
      BroadcastModel.countDocuments(),
    ]);
    return { data, total };
  }

  /** Maintenance job (every minute): sends queued broadcasts, oldest first, within a time budget. */
  async processDue(now = () => new Date(), budgetMs = RUN_BUDGET_MS) {
    const stopAt = Date.now() + budgetMs;
    let done = 0;
    while (Date.now() < stopAt) {
      const broadcast = await BroadcastModel.findOneAndUpdate(
        {
          status: { $ne: BroadcastStatus.SENT },
          $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now() } }],
        },
        { status: BroadcastStatus.SENDING, lockedUntil: new Date(now().getTime() + LEASE_MS) },
        { sort: { createdAt: 1 }, new: true },
      ).lean();
      if (!broadcast) return done;

      const filter = await this.audienceFilter({
        role: broadcast.segment.role,
        areaIds: broadcast.segment.areaIds.map(String),
      });
      let cursor = broadcast.cursor;
      for (;;) {
        const users = await UserModel.find(cursor ? { ...filter, _id: { $gt: cursor } } : filter)
          .sort({ _id: 1 })
          .limit(BATCH)
          .select('_id')
          .lean();
        if (users.length) {
          await Container.get(NotificationService).notify(
            users.map((u) => u._id),
            {
              type:
                broadcast.type === BroadcastType.ANNOUNCEMENT
                  ? NotificationType.ANNOUNCEMENT
                  : NotificationType.PROMO,
              template: 'broadcast',
              params: { title: broadcast.title, body: broadcast.body },
              data: { broadcast_id: String(broadcast._id) },
              dedupeKey: `broadcast:${String(broadcast._id)}`,
            },
          );
          cursor = users[users.length - 1]._id;
        }
        const last = users.length < BATCH;
        await BroadcastModel.updateOne(
          { _id: broadcast._id },
          {
            cursor,
            $inc: { sentCount: users.length },
            ...(last
              ? { status: BroadcastStatus.SENT, finishedAt: now(), lockedUntil: null }
              : { lockedUntil: new Date(now().getTime() + LEASE_MS) }),
          },
        );
        if (last) break;
        if (Date.now() >= stopAt) {
          // Out of time: let the next run pick it up.
          await BroadcastModel.updateOne({ _id: broadcast._id }, { lockedUntil: null });
          return done;
        }
      }
      logger.info(`Broadcast ${String(broadcast._id)} sent`);
      done++;
    }
    return done;
  }

  /** Active, non-admin users in the segment. Areas: patients by saved address, providers / staff by
   * service area, owners by their organization's areas. */
  private async audienceFilter(segment: { role: IBroadcastSegment['role']; areaIds: string[] }) {
    const roles = segment.role ? [segment.role as UserRole] : AUDIENCE_ROLES;
    const filter: FilterQuery<IUser> = { status: UserStatus.ACTIVE, role: { $in: roles } };
    if (!segment.areaIds.length) return filter;

    const areaIds = segment.areaIds.map((id) => new Types.ObjectId(id));
    const inAreas = { $in: areaIds };
    const ids = await Promise.all([
      roles.includes(UserRole.PATIENT) ? AddressModel.distinct('userId', { areaId: inAreas }) : [],
      roles.includes(UserRole.PROVIDER) || roles.includes(UserRole.PROVIDER_STAFF)
        ? ProviderProfileModel.distinct('userId', { 'serviceAreas.areaId': inAreas })
        : [],
      roles.includes(UserRole.OWNER)
        ? OrganizationModel.distinct('ownerUserId', { 'serviceAreas.areaId': inAreas })
        : [],
    ]);
    return { ...filter, _id: { $in: ids.flat() } };
  }
}
