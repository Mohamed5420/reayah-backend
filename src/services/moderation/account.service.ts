import { Container, Service } from 'typedi';
import { Types } from 'mongoose';
import { UserModel } from '../../database/models/user/user.model';
import { ProviderProfileModel } from '../../database/models/provider/provider-profile.model';
import { BookingModel } from '../../database/models/booking/booking.model';
import { BookingOfferModel } from '../../database/models/booking/booking-offer.model';
import { AuditLogModel } from '../../database/models/audit-log/audit-log.model';
import {
  DisputeModel,
  UserSuspensionModel,
  UserWarningModel,
} from '../../database/models/aftercare/aftercare.models';
import { UserRole, UserStatus } from '../../interfaces/enums';
import { ACTIVE_BOOKING_STATUSES, BookingActor, BookingStatus, OfferStatus } from '../../interfaces/IBooking';
import type { IUserWarning } from '../../interfaces/IAftercare';
import { NotificationType } from '../../interfaces/INotification';
import { invalidateCacheNamespace } from '../../utils/cache/cache';
import { logger } from '../../utils/logger/winston';
import { formatCairoDateTime } from '../../utils/time/cairo';
import { ConflictError, NotFoundError } from '../../utils/types-errors';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { TokenService } from '../auth/token.service';
import { canTransition } from '../booking/booking-state';
import { runBookingTransaction, transitionBooking } from '../booking/booking-transaction';
import { PROVIDER_PRICES_CACHE } from '../catalog/catalog.service';
import { NotificationService } from '../notification/notification.service';

/**
 * Account moderation (spec §7.15 users): timed or open-ended suspensions, warnings, reactivation, and
 * the history behind them. Every action is audited.
 */
@Service()
export class AccountService {
  private readonly audit = Container.get(AuditService);
  private readonly tokens = Container.get(TokenService);
  private readonly notifications = Container.get(NotificationService);

  /**
   * Suspends the account: sessions end, a provider stops taking bookings, and the user's active bookings
   * (as patient or provider) are cancelled — the other party is notified through the booking events.
   */
  async suspend(
    userId: string,
    input: { reason: string; durationDays: number | null; notify: boolean },
    context: AuditContext,
  ) {
    const user = await this.getUser(userId);
    if (user.role === UserRole.ADMIN && String(user._id) === context.actorId) {
      throw new ConflictError('errors.cannot_moderate_self');
    }
    const startsAt = new Date();
    const endsAt = input.durationDays
      ? new Date(startsAt.getTime() + input.durationDays * 24 * 3600_000)
      : null;
    await UserSuspensionModel.create({
      userId: user._id,
      reason: input.reason,
      startsAt,
      endsAt,
      createdBy: context.actorId,
    });
    user.status = UserStatus.SUSPENDED;
    user.isOnline = false;
    await user.save();
    await this.tokens.revokeAllForUser(userId);

    const provider = await ProviderProfileModel.findOne({ userId: user._id });
    if (provider?.isAcceptingBookings) {
      provider.isAcceptingBookings = false;
      await provider.save();
      await invalidateCacheNamespace(PROVIDER_PRICES_CACHE);
    }
    const cancelled = await this.cancelActiveBookings(user._id, provider?._id ?? null, 'account_suspended');

    await this.audit.log(context, {
      action: 'user.suspend',
      entityType: 'user',
      entityId: userId,
      metadata: { reason: input.reason, durationDays: input.durationDays, cancelledBookings: cancelled },
    });
    if (input.notify) {
      await this.notifications.notify([user._id], {
        type: NotificationType.ACCOUNT,
        template: endsAt ? 'account_suspended_until' : 'account_suspended',
        params: (lang) => ({ reason: input.reason, until: endsAt ? formatCairoDateTime(endsAt, lang) : '' }),
        data: { status: UserStatus.SUSPENDED },
      });
    }
    return { endsAt, cancelledBookings: cancelled };
  }

  async warn(
    userId: string,
    input: {
      reason: string;
      relatedType?: IUserWarning['relatedType'];
      relatedId?: string | null;
      notify: boolean;
    },
    context: AuditContext,
  ) {
    const user = await this.getUser(userId);
    const warning = await UserWarningModel.create({
      userId: user._id,
      reason: input.reason,
      relatedType: input.relatedType ?? null,
      relatedId: input.relatedId ?? null,
      createdBy: context.actorId,
    });
    await this.audit.log(context, {
      action: 'user.warn',
      entityType: 'user',
      entityId: userId,
      metadata: {
        reason: input.reason,
        relatedType: input.relatedType ?? null,
        relatedId: input.relatedId ?? null,
      },
    });
    if (input.notify) {
      await this.notifications.notify([user._id], {
        type: NotificationType.ACCOUNT,
        template: 'account_warning',
        params: { reason: input.reason },
        data: { warning_id: String(warning._id) },
      });
    }
    return warning.toObject();
  }

  /** Lifts any open suspension and reactivates the account. */
  async activate(userId: string, context: AuditContext) {
    const user = await this.getUser(userId);
    if (user.status !== UserStatus.SUSPENDED) throw new ConflictError('errors.not_suspended');
    await UserSuspensionModel.updateMany({ userId: user._id, liftedAt: null }, { liftedAt: new Date() });
    user.status = UserStatus.ACTIVE;
    await user.save();
    await this.audit.log(context, { action: 'user.activate', entityType: 'user', entityId: userId });
    await this.notifications.notify([user._id], {
      type: NotificationType.ACCOUNT,
      template: 'account_reactivated',
      data: { status: UserStatus.ACTIVE },
    });
  }

  /** Timed suspensions that have run out (maintenance sweep). Returns how many accounts were reactivated. */
  async liftExpired(now = new Date()) {
    const expired = await UserSuspensionModel.find({
      liftedAt: null,
      endsAt: { $ne: null, $lte: now },
    }).lean();
    let reactivated = 0;
    for (const suspension of expired) {
      await UserSuspensionModel.updateOne({ _id: suspension._id, liftedAt: null }, { liftedAt: now });
      const stillSuspended = await UserSuspensionModel.exists({
        userId: suspension.userId,
        liftedAt: null,
        $or: [{ endsAt: null }, { endsAt: { $gt: now } }],
      });
      if (stillSuspended) continue;
      const result = await UserModel.updateOne(
        { _id: suspension.userId, status: UserStatus.SUSPENDED },
        { status: UserStatus.ACTIVE },
      );
      if (result.modifiedCount) {
        reactivated++;
        await this.audit.log(
          { actorId: null },
          { action: 'user.suspension_expired', entityType: 'user', entityId: String(suspension.userId) },
        );
      }
    }
    return reactivated;
  }

  /** GET /admin/users/{id}/history. */
  async history(userId: string) {
    const user = await this.getUser(userId);
    const provider = await ProviderProfileModel.findOne({ userId: user._id }).select('_id').lean();
    const [suspensions, warnings, disputes, auditTrail] = await Promise.all([
      UserSuspensionModel.find({ userId: user._id }).sort({ createdAt: -1 }).lean(),
      UserWarningModel.find({ userId: user._id }).sort({ createdAt: -1 }).lean(),
      DisputeModel.find({
        $or: [{ patientUserId: user._id }, ...(provider ? [{ providerProfileId: provider._id }] : [])],
      })
        .sort({ createdAt: -1 })
        .lean(),
      AuditLogModel.find({ $or: [{ entityId: userId }, { actorId: user._id }] })
        .sort({ createdAt: -1 })
        .limit(100)
        .lean(),
    ]);
    return { suspensions, warnings, disputes, auditTrail };
  }

  /**
   * Cancels a user's pending / accepted / on-the-way bookings (admin actor) and withdraws their open
   * offers. Visits already in progress are left alone. Returns how many bookings were cancelled.
   */
  async cancelActiveBookings(userId: Types.ObjectId, providerProfileId: Types.ObjectId | null, code: string) {
    const bookings = await BookingModel.find({
      status: { $in: ACTIVE_BOOKING_STATUSES },
      $or: [{ patientUserId: userId }, ...(providerProfileId ? [{ providerProfileId }] : [])],
    }).lean();
    let cancelled = 0;
    for (const booking of bookings) {
      if (!canTransition(booking.status, BookingStatus.CANCELLED, BookingActor.ADMIN, booking.type)) continue;
      try {
        await runBookingTransaction(async (tx) => {
          await transitionBooking(tx, booking, BookingStatus.CANCELLED, BookingActor.ADMIN, {
            set: { cancellationReason: { code, text: null }, cancelledBy: BookingActor.ADMIN },
            note: code,
          });
          await BookingOfferModel.updateMany(
            { bookingId: booking._id, status: OfferStatus.OFFERED },
            { status: OfferStatus.EXPIRED },
            { session: tx.session },
          );
        });
        cancelled++;
      } catch (err) {
        logger.error(`Could not cancel booking ${String(booking._id)} on suspension`, err);
      }
    }
    if (providerProfileId) {
      await BookingOfferModel.updateMany(
        { providerProfileId, status: OfferStatus.OFFERED },
        { status: OfferStatus.EXPIRED },
      );
    }
    return cancelled;
  }

  private async getUser(userId: string) {
    const user = Types.ObjectId.isValid(userId) ? await UserModel.findById(userId) : null;
    if (!user) throw new NotFoundError('errors.user_not_found');
    return user;
  }
}
