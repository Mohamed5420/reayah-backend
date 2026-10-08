import { Container, Service } from 'typedi';
import { Types, type ClientSession, type HydratedDocument } from 'mongoose';
import { OrganizationModel, StaffInviteModel } from '../../database/models/organization/organization.models';
import { BookingModel } from '../../database/models/booking/booking.model';
import { PayoutModel } from '../../database/models/payout/payout.models';
import { ProviderProfileModel } from '../../database/models/provider/provider-profile.model';
import { UserModel } from '../../database/models/user/user.model';
import { WalletBalanceModel } from '../../database/models/ledger/wallet.model';
import { withTransaction } from '../../database/transaction';
import { ProviderType, UserRole, VerificationStatus } from '../../interfaces/enums';
import { ACTIVE_BOOKING_STATUSES, BookingStatus } from '../../interfaces/IBooking';
import { LedgerOwnerType } from '../../interfaces/ILedger';
import { NotificationType } from '../../interfaces/INotification';
import { env } from '../../config/env.config';
import {
  LAPSED_INVITE_RETENTION_DAYS,
  STAFF_INVITE_DAYS,
  StaffInviteStatus,
  type IOrganization,
  type IStaffInvite,
} from '../../interfaces/IOrganization';
import type { IAvailabilitySlot, IProviderProfile } from '../../interfaces/IProfiles';
import { PayoutStatus } from '../../interfaces/IPayout';
import { t } from '../../utils/i18n';
import { logger } from '../../utils/logger/winston';
import { isOverLimit } from '../../utils/rate-limit';
import type { Pagination } from '../../utils/response/pagination';
import {
  ConflictError,
  NotFoundError,
  TooManyRequestsError,
  ValidationError,
  type ErrorFields,
} from '../../utils/types-errors';
import { CatalogService } from '../catalog/catalog.service';
import { NotificationService } from '../notification/notification.service';
import { ProviderCoverageService } from '../provider/provider-coverage.service';
import { SmsService } from '../sms/sms.service';
import type { OrganizationDoc } from './organization.service';
import { OrgBookingService } from './org-booking.service';
import { SubscriptionService } from './subscription.service';

/** Invites per organization per day (SMS costs money and can be abused). */
const INVITES_PER_DAY = 30;
const DAY_MS = 24 * 3600_000;

type ProfileDoc = HydratedDocument<IProviderProfile>;

const addError = (fields: ErrorFields, key: string, message: string) => {
  (fields[key] ??= []).push(message);
};

/**
 * Team management (spec §7.11 "Dashboard & team", M3.2). Owners invite nurses / doctors by phone; a new
 * number signs up with the invite and becomes `provider_staff` of the organization, and an independent
 * provider can accept it in the app if they have no active bookings and a zero balance (decision:
 * patient and owner accounts can't join). Staff still go through document verification. The owner sets
 * each member's services (from the organization's), areas (from the organization's, at its travel
 * fee) and weekly hours, can suspend / reactivate them within the organization, and can remove them
 * at any time: they become independent providers, keep their verification, and take no bookings until
 * they set their own areas, services and prices. (M3.3: removal also hands their active bookings back
 * to the organization's unassigned queue and cuts their access to those bookings and chats.)
 */
@Service()
export class StaffService {
  private readonly notifications = Container.get(NotificationService);
  private readonly catalog = Container.get(CatalogService);

  // ── Invites (owner) ──

  async invite(
    org: IOrganization,
    ownerId: string,
    input: { phone: string; fullName: string; type: ProviderType },
  ) {
    if (org.verificationStatus !== VerificationStatus.APPROVED) {
      throw new ConflictError('errors.organization_not_approved');
    }
    const existing = await UserModel.findOne({ phone: input.phone }).lean();
    if (existing) await this.assertCanJoin(existing, org._id);
    // Plan limit (decision M3.4): members + open invites; existing staff are never affected.
    await Container.get(SubscriptionService).assertCanAddStaff(org._id);
    if (await isOverLimit(`staff-invite:${String(org._id)}`, INVITES_PER_DAY, 24 * 3600)) {
      throw new TooManyRequestsError();
    }
    // A new invite to the same number replaces the open one (e.g. a typo in the name).
    await StaffInviteModel.updateMany(
      { organizationId: org._id, phone: input.phone, status: StaffInviteStatus.PENDING },
      { status: StaffInviteStatus.REVOKED, respondedAt: new Date() },
    );
    const invite = await StaffInviteModel.create({
      organizationId: org._id,
      phone: input.phone,
      fullName: input.fullName,
      type: input.type,
      invitedBy: ownerId,
      expiresAt: new Date(Date.now() + STAFF_INVITE_DAYS * DAY_MS),
    });
    await Container.get(SmsService)
      // Nothing about the person: the organization's name and the app link only (default pending counsel).
      .send(input.phone, t('sms.staff_invite', { organization: org.name, link: env.appDownloadUrl }))
      .catch((err: unknown) => logger.error(`Staff invite SMS to invite ${String(invite._id)} failed`, err));
    if (existing) {
      await this.notifications.notify([existing._id], {
        type: NotificationType.ACCOUNT,
        template: 'staff_invite',
        params: { organization: org.name },
        data: { invite_id: String(invite._id) },
      });
    }
    return invite.toObject();
  }

  pendingInvites(orgId: Types.ObjectId) {
    return StaffInviteModel.find({
      organizationId: orgId,
      status: StaffInviteStatus.PENDING,
      expiresAt: { $gt: new Date() },
    })
      .sort({ createdAt: -1 })
      .lean();
  }

  async revoke(orgId: Types.ObjectId, inviteId: string) {
    const updated = Types.ObjectId.isValid(inviteId)
      ? await StaffInviteModel.findOneAndUpdate(
          { _id: inviteId, organizationId: orgId, status: StaffInviteStatus.PENDING },
          { status: StaffInviteStatus.REVOKED, respondedAt: new Date() },
        )
      : null;
    if (!updated) throw new NotFoundError('errors.invite_not_found');
  }

  /** Pending, accepted and never-accepted invites (the last includes ones already purged). */
  async inviteStats(orgId: Types.ObjectId, lapsedPurged: number) {
    const rows = await StaffInviteModel.aggregate<{ _id: string; count: number }>([
      { $match: { organizationId: orgId } },
      {
        $group: {
          _id: {
            $cond: [
              { $eq: ['$status', StaffInviteStatus.ACCEPTED] },
              'accepted',
              {
                $cond: [
                  {
                    $and: [
                      { $eq: ['$status', StaffInviteStatus.PENDING] },
                      { $gt: ['$expiresAt', new Date()] },
                    ],
                  },
                  'pending',
                  'not_accepted',
                ],
              },
            ],
          },
          count: { $sum: 1 },
        },
      },
    ]);
    const count = (key: string) => rows.find((r) => r._id === key)?.count ?? 0;
    return {
      pending: count('pending'),
      accepted: count('accepted'),
      notAccepted: count('not_accepted') + lapsedPurged,
    };
  }

  /**
   * Daily (STAFF_INVITE_PURGE): invites never accepted — expired, declined or revoked — are deleted
   * `LAPSED_INVITE_RETENTION_DAYS` after they expired; each organization keeps only the count.
   */
  async purgeLapsed(now = new Date()) {
    const cutoff = new Date(now.getTime() - LAPSED_INVITE_RETENTION_DAYS * DAY_MS);
    const query = { status: { $ne: StaffInviteStatus.ACCEPTED }, expiresAt: { $lte: cutoff } };
    const orgIds: Types.ObjectId[] = await StaffInviteModel.distinct('organizationId', query);
    let purged = 0;
    for (const organizationId of orgIds) {
      purged += await withTransaction(async (session) => {
        const { deletedCount } = await StaffInviteModel.deleteMany({ ...query, organizationId }, { session });
        await OrganizationModel.updateOne(
          { _id: organizationId },
          { $inc: { lapsedInvitesCount: deletedCount } },
          { session },
        ).setOptions({ withDeleted: true });
        return deletedCount;
      });
    }
    return purged;
  }

  // ── Invites (invitee) ──

  /** Open invites for a phone number, with the organization name (sign-up and the provider app). */
  async invitesForPhone(phone: string) {
    const invites = await StaffInviteModel.find({
      phone,
      status: StaffInviteStatus.PENDING,
      expiresAt: { $gt: new Date() },
    })
      .populate<{ organizationId: Pick<IOrganization, '_id' | 'name'> | null }>('organizationId', 'name')
      .sort({ createdAt: -1 })
      .lean();
    return invites.flatMap((i) =>
      i.organizationId
        ? [
            {
              invite: { ...i, organizationId: i.organizationId._id } as IStaffInvite,
              organizationName: i.organizationId.name,
            },
          ]
        : [],
    );
  }

  /**
   * Sign-up with an invite (inside the registration transaction): the new user becomes staff of the
   * organization with a draft profile of the invited type.
   */
  async joinAtSignup(
    session: ClientSession,
    user: { _id: Types.ObjectId; phone: string; isTestAccount?: boolean },
    inviteId: string,
  ) {
    const invite = await this.claim(session, inviteId, user.phone, user._id);
    await Container.get(SubscriptionService).assertCanAddStaff(invite.organizationId, false);
    await ProviderProfileModel.create(
      [
        {
          userId: user._id,
          organizationId: invite.organizationId,
          type: invite.type,
          isTestAccount: Boolean(user.isTestAccount),
        },
      ],
      { session },
    );
    return invite;
  }

  /** An independent provider accepts in the app: no active bookings, zero balance, no open payout. */
  async accept(userId: string, inviteId: string) {
    const user = await UserModel.findById(userId).lean();
    if (!user) throw new NotFoundError('errors.user_not_found');
    const profile = await ProviderProfileModel.findOne({ userId });
    if (!profile) throw new NotFoundError('errors.provider_profile_not_found');
    const invite = await withTransaction(async (session) => {
      const claimed = await this.claim(session, inviteId, user.phone, user._id);
      await this.assertCanJoin(user, claimed.organizationId, session);
      await Container.get(SubscriptionService).assertCanAddStaff(claimed.organizationId, false);
      await UserModel.updateOne({ _id: userId }, { role: UserRole.PROVIDER_STAFF }, { session });
      // Areas, services and prices now come from the organization (the owner sets them).
      await ProviderProfileModel.updateOne(
        { _id: profile._id },
        {
          organizationId: claimed.organizationId,
          staffSuspended: false,
          serviceAreas: [],
          services: [],
          isAcceptingBookings: false,
        },
        { session },
      );
      return claimed;
    });
    await this.notifyOwner(invite, user.fullName);
    return invite;
  }

  async decline(userId: string, inviteId: string) {
    const user = await UserModel.findById(userId).lean();
    const updated =
      user && Types.ObjectId.isValid(inviteId)
        ? await StaffInviteModel.findOneAndUpdate(
            { _id: inviteId, phone: user.phone, status: StaffInviteStatus.PENDING },
            { status: StaffInviteStatus.DECLINED, respondedAt: new Date() },
          )
        : null;
    if (!updated) throw new NotFoundError('errors.invite_not_found');
  }

  async notifyOwner(invite: Pick<IStaffInvite, 'organizationId'>, name: string) {
    const org = await OrganizationModel.findById(invite.organizationId).select('ownerUserId').lean();
    if (!org) return;
    await this.notifications
      .notify([org.ownerUserId], {
        type: NotificationType.ACCOUNT,
        template: 'staff_joined',
        params: { name },
        data: { organization_id: String(invite.organizationId) },
      })
      .catch((err: unknown) => logger.error('Staff joined notice failed', err));
  }

  // ── Team (owner) ──

  async list(
    orgId: Types.ObjectId,
    filters: { status?: 'active' | 'suspended' | 'pending_verification'; type?: ProviderType },
    pagination: Pagination,
  ) {
    const query = {
      organizationId: orgId,
      ...(filters.type ? { type: filters.type } : {}),
      ...(filters.status === 'suspended' ? { staffSuspended: true } : {}),
      ...(filters.status === 'active'
        ? { staffSuspended: false, verificationStatus: VerificationStatus.APPROVED }
        : {}),
      ...(filters.status === 'pending_verification'
        ? { verificationStatus: { $ne: VerificationStatus.APPROVED } }
        : {}),
    };
    const [profiles, total] = await Promise.all([
      ProviderProfileModel.find(query)
        .sort({ createdAt: 1 })
        .skip(pagination.skip)
        .limit(pagination.perPage)
        .lean(),
      ProviderProfileModel.countDocuments(query),
    ]);
    const users = await UserModel.find({ _id: { $in: profiles.map((p) => p.userId) } })
      .select('fullName phone gender avatarKey isOnline')
      .lean();
    const userById = new Map(users.map((u) => [String(u._id), u]));
    return {
      data: profiles.flatMap((profile) => {
        const user = userById.get(String(profile.userId));
        return user ? [{ profile, user }] : [];
      }),
      total,
    };
  }

  /** A member of this organization (404 for anyone else's). */
  async member(orgId: Types.ObjectId, profileId: string): Promise<ProfileDoc> {
    const profile = Types.ObjectId.isValid(profileId)
      ? await ProviderProfileModel.findOne({ _id: profileId, organizationId: orgId })
      : null;
    if (!profile) throw new NotFoundError('errors.staff_not_found');
    return profile;
  }

  /** Details + performance: visits completed, rating, on-time rate, visits in the last 30 days. */
  async details(orgId: Types.ObjectId, profileId: string) {
    const profile = await this.member(orgId, profileId);
    const user = await UserModel.findById(profile.userId).lean();
    const since = new Date(Date.now() - 30 * DAY_MS);
    const [onTime, recent] = await Promise.all([
      BookingModel.aggregate<{ _id: null; total: number; onTime: number }>([
        { $match: { providerProfileId: profile._id, isOnTime: { $ne: null } } },
        { $group: { _id: null, total: { $sum: 1 }, onTime: { $sum: { $cond: ['$isOnTime', 1, 0] } } } },
      ]),
      BookingModel.countDocuments({
        providerProfileId: profile._id,
        status: BookingStatus.COMPLETED,
        completedAt: { $gte: since },
      }),
    ]);
    const timing = onTime[0];
    return {
      profile,
      user,
      performance: {
        completedVisits: profile.completedVisitsCount,
        completedLast30Days: recent,
        ratingAvg: profile.ratingAvg,
        ratingCount: profile.ratingCount,
        onTimeRate: timing?.total ? Math.round((timing.onTime / timing.total) * 100) : null,
      },
    };
  }

  /** PATCH /org/staff/{id}: suspend / reactivate within the organization, and set their services. */
  async update(
    org: OrganizationDoc,
    profileId: string,
    patch: { status?: 'active' | 'suspended'; serviceIds?: string[] },
  ) {
    const profile = await this.member(org._id, profileId);
    if (patch.serviceIds) {
      const catalog = new Map((await this.catalog.activeServices()).map((s) => [s.id, s]));
      const offered = new Map(org.services.filter((s) => s.isActive).map((s) => [String(s.serviceId), s]));
      const fields: ErrorFields = {};
      const seen = new Set<string>();
      for (const [i, id] of patch.serviceIds.entries()) {
        if (seen.has(id)) addError(fields, `service_ids.${i}`, 'validation.duplicate');
        seen.add(id);
        const service = catalog.get(id);
        if (!offered.has(id) || !service)
          addError(fields, `service_ids.${i}`, 'validation.service_not_offered_by_org');
        else if (service.providerType !== profile.type)
          addError(fields, `service_ids.${i}`, 'validation.service_wrong_type');
      }
      if (Object.keys(fields).length) throw new ValidationError(fields);
      // The organization's price applies (shown here for reference; bookings read the org's list).
      profile.set(
        'services',
        patch.serviceIds.map((id) => ({
          serviceId: new Types.ObjectId(id),
          price: offered.get(id)!.price,
          isActive: true,
        })),
      );
    }
    if (patch.status === 'suspended') {
      profile.staffSuspended = true;
      profile.isAcceptingBookings = false;
    } else if (patch.status === 'active') {
      profile.staffSuspended = false;
    }
    await profile.save();
    if (patch.status) {
      await this.notifications.notify([profile.userId], {
        type: NotificationType.ACCOUNT,
        template: patch.status === 'suspended' ? 'staff_suspended' : 'staff_activated',
        params: { organization: org.name },
        data: { organization_id: String(org._id) },
      });
    }
    return profile;
  }

  /** PUT /org/staff/{id}/service-areas: areas the organization serves; its travel fee applies. */
  async setAreas(org: OrganizationDoc, profileId: string, areaIds: string[]) {
    const profile = await this.member(org._id, profileId);
    const orgAreas = new Map(org.serviceAreas.filter((a) => a.isActive).map((a) => [String(a.areaId), a]));
    const fields: ErrorFields = {};
    const seen = new Set<string>();
    for (const [i, id] of areaIds.entries()) {
      if (seen.has(id)) addError(fields, `area_ids.${i}`, 'validation.duplicate');
      seen.add(id);
      if (!orgAreas.has(id)) addError(fields, `area_ids.${i}`, 'validation.area_not_served_by_org');
    }
    if (Object.keys(fields).length) throw new ValidationError(fields);
    profile.set(
      'serviceAreas',
      areaIds.map((id) => ({ areaId: new Types.ObjectId(id), travelFee: orgAreas.get(id)!.travelFee })),
    );
    await profile.save();
    return profile;
  }

  async setAvailability(orgId: Types.ObjectId, profileId: string, slots: IAvailabilitySlot[]) {
    return Container.get(ProviderCoverageService).replaceAvailability(
      await this.member(orgId, profileId),
      slots,
    );
  }

  /**
   * DELETE /org/staff/{id} — always allowed. They become an independent provider: verification kept,
   * not accepting, no areas or services until they set their own.
   */
  async remove(org: OrganizationDoc, profileId: string) {
    const profile = await this.member(org._id, profileId);
    // Decision: their active bookings go back to the organization's queue and they lose access at once.
    await Container.get(OrgBookingService).takeBackFrom(org._id, profile._id, String(org.ownerUserId));
    await withTransaction(async (session) => {
      await ProviderProfileModel.updateOne(
        { _id: profile._id, organizationId: org._id },
        {
          organizationId: null,
          staffSuspended: false,
          isAcceptingBookings: false,
          serviceAreas: [],
          services: [],
        },
        { session },
      );
      await UserModel.updateOne({ _id: profile.userId }, { role: UserRole.PROVIDER }, { session });
    });
    await this.notifications.notify([profile.userId], {
      type: NotificationType.ACCOUNT,
      template: 'staff_removed',
      params: { organization: org.name },
      data: { organization_id: String(org._id) },
    });
  }

  // ── Helpers ──

  /** Marks a pending, unexpired invite for this phone as accepted (once). */
  private async claim(session: ClientSession, inviteId: string, phone: string, userId: Types.ObjectId) {
    const invite = Types.ObjectId.isValid(inviteId)
      ? await StaffInviteModel.findOneAndUpdate(
          { _id: inviteId, phone, status: StaffInviteStatus.PENDING, expiresAt: { $gt: new Date() } },
          { status: StaffInviteStatus.ACCEPTED, respondedAt: new Date(), userId },
          { new: true, session },
        ).lean()
      : null;
    if (!invite) throw new NotFoundError('errors.invite_not_found');
    return invite;
  }

  /**
   * Who may join (decision): new numbers, and independent providers with no active bookings, a zero
   * balance and no open payout. Not patients, owners, admins or someone else's staff.
   */
  private async assertCanJoin(
    user: { _id: Types.ObjectId; role: UserRole },
    orgId: Types.ObjectId,
    session?: ClientSession,
  ) {
    if (user.role !== UserRole.PROVIDER) {
      const own =
        user.role === UserRole.PROVIDER_STAFF
          ? await ProviderProfileModel.exists({ userId: user._id, organizationId: orgId }).session(
              session ?? null,
            )
          : null;
      throw new ConflictError(own ? 'errors.staff_already_member' : 'errors.staff_invite_not_eligible');
    }
    const profile = await ProviderProfileModel.findOne({ userId: user._id })
      .session(session ?? null)
      .lean();
    if (!profile) throw new ConflictError('errors.staff_invite_not_eligible');
    const [active, wallet, openPayout] = await Promise.all([
      BookingModel.exists({
        providerProfileId: profile._id,
        status: { $in: ACTIVE_BOOKING_STATUSES },
      }).session(session ?? null),
      WalletBalanceModel.findOne({ ownerType: LedgerOwnerType.PROVIDER, ownerId: profile._id })
        .session(session ?? null)
        .lean(),
      PayoutModel.exists({
        ownerId: profile._id,
        status: { $in: [PayoutStatus.PENDING, PayoutStatus.APPROVED] },
      }).session(session ?? null),
    ]);
    if (active) throw new ConflictError('errors.staff_join_active_bookings');
    if ((wallet?.balance ?? 0) !== 0 || openPayout) throw new ConflictError('errors.staff_join_balance');
  }
}
