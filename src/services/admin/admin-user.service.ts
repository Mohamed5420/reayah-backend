import { Container, Service } from 'typedi';
import { Types, type FilterQuery } from 'mongoose';
import { UserModel } from '../../database/models/user/user.model';
import { ProviderProfileModel } from '../../database/models/provider/provider-profile.model';
import { BookingModel } from '../../database/models/booking/booking.model';
import { ProviderType, UserRole, UserStatus, VerificationStatus } from '../../interfaces/enums';
import type { IUser } from '../../interfaces/IUser';
import type { IProviderProfile } from '../../interfaces/IProfiles';
import { invalidateCacheNamespace } from '../../utils/cache/cache';
import { escapeRegExp } from '../../utils/text/arabic';
import type { Pagination } from '../../utils/response/pagination';
import { ConflictError, NotFoundError } from '../../utils/types-errors';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { PROVIDER_PRICES_CACHE } from '../catalog/catalog.service';
import { AccountService } from '../moderation/account.service';
import { TokenService } from '../auth/token.service';

/** Admin panel users, providers and admin accounts (spec §7.15). Every write is audited. */
@Service()
export class AdminUserService {
  private readonly audit = Container.get(AuditService);
  private readonly accounts = Container.get(AccountService);
  private readonly tokens = Container.get(TokenService);

  async listUsers(
    filters: { role?: UserRole; status?: UserStatus; search?: string },
    pagination: Pagination,
  ) {
    const query: FilterQuery<IUser> = {
      ...(filters.role ? { role: filters.role } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.search
        ? {
            $or: [
              { fullName: { $regex: escapeRegExp(filters.search.trim()), $options: 'i' } },
              { phone: { $regex: escapeRegExp(filters.search.trim()) } },
            ],
          }
        : {}),
    };
    // Deleted accounts only show up when asked for by status.
    const withDeleted = filters.status === UserStatus.DELETED;
    const [data, total] = await Promise.all([
      UserModel.find(query)
        .setOptions({ withDeleted })
        .sort({ createdAt: -1 })
        .skip(pagination.skip)
        .limit(pagination.perPage)
        .lean(),
      UserModel.countDocuments(query).setOptions({ withDeleted }),
    ]);
    return { data, total };
  }

  async getUser(userId: string) {
    const user = Types.ObjectId.isValid(userId) ? await UserModel.findById(userId).lean() : null;
    if (!user) throw new NotFoundError('errors.user_not_found');
    const provider = await ProviderProfileModel.findOne({ userId: user._id }).lean();
    const bookings = await BookingModel.countDocuments({
      $or: [{ patientUserId: user._id }, ...(provider ? [{ providerProfileId: provider._id }] : [])],
    });
    // The patient's cancellation record: free late cancellations, and travel-fee charges
    // (cancelled after "on the way" / no-show) with the cash ones not collected at launch.
    const [record] = await BookingModel.aggregate<{
      lateCancellations: number;
      charges: number;
      chargesTotal: number;
      uncollected: number;
      uncollectedTotal: number;
    }>([
      {
        $match: { patientUserId: user._id, $or: [{ lateCancellation: true }, { patientFee: { $ne: null } }] },
      },
      {
        $group: {
          _id: null,
          lateCancellations: { $sum: { $cond: ['$lateCancellation', 1, 0] } },
          charges: { $sum: { $cond: [{ $ne: ['$patientFee', null] }, 1, 0] } },
          chargesTotal: { $sum: { $ifNull: ['$patientFee.amount', 0] } },
          uncollected: { $sum: { $cond: [{ $eq: ['$patientFee.collected', false] }, 1, 0] } },
          uncollectedTotal: {
            $sum: { $cond: [{ $eq: ['$patientFee.collected', false] }, '$patientFee.amount', 0] },
          },
        },
      },
    ]);
    return {
      user,
      provider,
      bookings,
      cancellationRecord: {
        lateCancellations: record?.lateCancellations ?? 0,
        travelFeeCharges: {
          count: record?.charges ?? 0,
          total: record?.chargesTotal ?? 0,
          uncollected: { count: record?.uncollected ?? 0, total: record?.uncollectedTotal ?? 0 },
        },
      },
    };
  }

  async listProviders(
    filters: { verificationStatus?: VerificationStatus; areaId?: string; type?: ProviderType },
    pagination: Pagination,
  ) {
    const query: FilterQuery<IProviderProfile> = {
      ...(filters.verificationStatus ? { verificationStatus: filters.verificationStatus } : {}),
      ...(filters.areaId ? { 'serviceAreas.areaId': filters.areaId } : {}),
      ...(filters.type ? { type: filters.type } : {}),
    };
    const [profiles, total] = await Promise.all([
      ProviderProfileModel.find(query)
        .sort({ createdAt: -1 })
        .skip(pagination.skip)
        .limit(pagination.perPage)
        .lean(),
      ProviderProfileModel.countDocuments(query),
    ]);
    const users = await UserModel.find({ _id: { $in: profiles.map((p) => p.userId) } })
      .setOptions({ withDeleted: true })
      .lean();
    const userById = new Map(users.map((u) => [String(u._id), u]));
    return {
      data: profiles.map((profile) => ({ profile, user: userById.get(String(profile.userId))! })),
      total,
    };
  }

  async getProvider(providerProfileId: string) {
    const profile = Types.ObjectId.isValid(providerProfileId)
      ? await ProviderProfileModel.findById(providerProfileId)
      : null;
    if (!profile) throw new NotFoundError('errors.provider_profile_not_found');
    const user = await UserModel.findById(profile.userId).setOptions({ withDeleted: true }).lean();
    const stats = await BookingModel.aggregate<{ _id: string; count: number }>([
      { $match: { providerProfileId: profile._id } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);
    return { profile, user: user!, bookingsByStatus: Object.fromEntries(stats.map((s) => [s._id, s.count])) };
  }

  /**
   * PATCH /admin/providers/{id}: suspend the provider's listing (approved → suspended, which also stops
   * bookings and cancels upcoming ones) or restore it (suspended → approved), and/or message them.
   * Other verification moves go through /admin/verifications.
   */
  async updateProvider(
    providerProfileId: string,
    input: { verificationStatus?: VerificationStatus; adminMessage?: string | null },
    context: AuditContext,
  ) {
    const { profile } = await this.getProvider(providerProfileId);
    const from = profile.verificationStatus;
    if (input.verificationStatus && input.verificationStatus !== from) {
      const allowed =
        (from === VerificationStatus.APPROVED && input.verificationStatus === VerificationStatus.SUSPENDED) ||
        (from === VerificationStatus.SUSPENDED && input.verificationStatus === VerificationStatus.APPROVED);
      if (!allowed) throw new ConflictError('errors.use_verification_flow');
      profile.verificationStatus = input.verificationStatus;
      if (input.verificationStatus === VerificationStatus.SUSPENDED) profile.isAcceptingBookings = false;
    }
    if (input.adminMessage !== undefined) profile.adminMessage = input.adminMessage;
    await profile.save();
    if (from === VerificationStatus.APPROVED && profile.verificationStatus === VerificationStatus.SUSPENDED) {
      await this.accounts.cancelActiveBookings(profile.userId, profile._id, 'provider_suspended');
    }
    await invalidateCacheNamespace(PROVIDER_PRICES_CACHE);
    await this.audit.log(context, {
      action: 'provider.update',
      entityType: 'provider_profile',
      entityId: providerProfileId,
      metadata: { from, to: profile.verificationStatus, adminMessage: input.adminMessage ?? undefined },
    });
    return this.getProvider(providerProfileId);
  }

  listAdmins() {
    return UserModel.find({ role: UserRole.ADMIN }).sort({ createdAt: 1 }).lean();
  }

  /** POST /admin/admins — same rules as `npm run admin:create`: the phone mustn't belong to another account. */
  async createAdmin(input: { phone: string; fullName: string }, context: AuditContext) {
    if (await UserModel.exists({ phone: input.phone })) throw new ConflictError('errors.phone_taken');
    const admin = await UserModel.create({
      phone: input.phone,
      fullName: input.fullName,
      role: UserRole.ADMIN,
    });
    await this.audit.log(context, {
      action: 'admin.create',
      entityType: 'user',
      entityId: String(admin._id),
      metadata: { phone: input.phone },
    });
    return admin.toObject();
  }

  /** PATCH /admin/admins/{id} — disable (suspend) or re-enable another admin. Admin sub-roles are still TBD. */
  async updateAdmin(
    adminId: string,
    input: { status: UserStatus.ACTIVE | UserStatus.SUSPENDED },
    context: AuditContext,
  ) {
    if (adminId === context.actorId) throw new ConflictError('errors.cannot_moderate_self');
    const admin = Types.ObjectId.isValid(adminId)
      ? await UserModel.findOne({ _id: adminId, role: UserRole.ADMIN })
      : null;
    if (!admin) throw new NotFoundError('errors.user_not_found');
    // No "last admin" check needed: the caller is an active admin and can't disable themselves.
    const from = admin.status;
    admin.status = input.status;
    await admin.save();
    if (input.status === UserStatus.SUSPENDED) await this.tokens.revokeAllForUser(adminId);
    await this.audit.log(context, {
      action: 'admin.update',
      entityType: 'user',
      entityId: adminId,
      metadata: { from, to: input.status },
    });
    return admin.toObject();
  }
}
