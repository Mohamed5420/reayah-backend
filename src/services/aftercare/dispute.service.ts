import { Container, Service } from 'typedi';
import { Types } from 'mongoose';
import { BookingModel } from '../../database/models/booking/booking.model';
import { DisputeModel } from '../../database/models/aftercare/aftercare.models';
import { ProviderProfileModel } from '../../database/models/provider/provider-profile.model';
import { BookingActor, BookingStatus } from '../../interfaces/IBooking';
import { DisputeResolution, DisputeStatus, ProviderAction, type IDispute } from '../../interfaces/IAftercare';
import { NotificationType } from '../../interfaces/INotification';
import type { Pagination } from '../../utils/response/pagination';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/types-errors';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { runBookingTransaction, transitionBooking } from '../booking/booking-transaction';
import { AccountService } from '../moderation/account.service';
import { NotificationService } from '../notification/notification.service';
import { SettingsService } from '../settings/settings.service';
import { StorageService } from '../storage/storage.service';

export type ResolveDisputeInput = {
  resolution: DisputeResolution;
  refundAmount?: number;
  providerAction: ProviderAction;
  suspendDays?: number | null;
  messageToPatient?: string | null;
  messageToProvider?: string | null;
};

/**
 * "Report a problem" (spec §7.8, §7.15). A patient opens one per booking, within
 * `dispute_window_hours` of a completed visit or a recorded no-show; the booking becomes `disputed`.
 * An admin resolves it, optionally warning or suspending the provider and messaging both sides.
 */
@Service()
export class DisputeService {
  private readonly settings = Container.get(SettingsService);
  private readonly storage = Container.get(StorageService);
  private readonly accounts = Container.get(AccountService);
  private readonly notifications = Container.get(NotificationService);
  private readonly audit = Container.get(AuditService);

  async open(
    userId: string,
    bookingId: string,
    input: { reasonCode: string; description?: string | null; attachments?: string[] },
  ) {
    const booking = Types.ObjectId.isValid(bookingId)
      ? await BookingModel.findOne({ _id: bookingId, patientUserId: userId }).lean()
      : null;
    if (!booking) throw new NotFoundError('errors.booking_not_found');
    if (![BookingStatus.COMPLETED, BookingStatus.NO_SHOW].includes(booking.status)) {
      throw new ConflictError('errors.dispute_not_allowed');
    }
    const windowHours = await this.settings.get('dispute_window_hours');
    const visitEnded = booking.completedAt ?? booking.scheduledEnd;
    if (Date.now() - visitEnded.getTime() > windowHours * 3600_000) {
      throw new ConflictError('errors.dispute_window_passed');
    }
    if (await DisputeModel.exists({ bookingId: booking._id }))
      throw new ConflictError('errors.dispute_exists');

    const attachmentKeys = await Promise.all(
      (input.attachments ?? []).map((key) =>
        this.storage.promote(key, {
          ownerId: userId,
          purpose: 'dispute',
          destPrefix: `disputes/${bookingId}`,
        }),
      ),
    );
    return runBookingTransaction(async (tx) => {
      await transitionBooking(tx, booking, BookingStatus.DISPUTED, BookingActor.PATIENT, {
        changedBy: userId,
        note: input.reasonCode,
      });
      const [dispute] = await DisputeModel.create(
        [
          {
            bookingId: booking._id,
            patientUserId: userId,
            providerProfileId: booking.providerProfileId,
            reasonCode: input.reasonCode,
            description: input.description ?? null,
            attachmentKeys,
          },
        ],
        { session: tx.session },
      );
      return dispute.toObject();
    });
  }

  async list(filters: { status?: DisputeStatus }, pagination: Pagination) {
    const query = filters.status ? { status: filters.status } : {};
    const [data, total] = await Promise.all([
      DisputeModel.find(query).sort({ createdAt: 1 }).skip(pagination.skip).limit(pagination.perPage).lean(),
      DisputeModel.countDocuments(query),
    ]);
    return { data, total };
  }

  async get(disputeId: string) {
    const dispute = Types.ObjectId.isValid(disputeId) ? await DisputeModel.findById(disputeId).lean() : null;
    if (!dispute) throw new NotFoundError('errors.dispute_not_found');
    const booking = await BookingModel.findById(dispute.bookingId).lean();
    const attachments = await Promise.all(dispute.attachmentKeys.map((key) => this.storage.signedUrl(key)));
    return { dispute, booking: booking!, attachments };
  }

  /**
   * Records the decision. Refund amounts are recorded only for now — cash bookings are settled outside
   * the app until card payments arrive (Phase 2).
   */
  async resolve(disputeId: string, input: ResolveDisputeInput, context: AuditContext) {
    const { dispute, booking } = await this.get(disputeId);
    if (dispute.status !== DisputeStatus.OPEN) throw new ConflictError('errors.dispute_resolved');
    const total = booking.price.total;
    let refundAmount = 0;
    if (input.resolution === DisputeResolution.REFUND) refundAmount = input.refundAmount ?? total;
    if (input.resolution === DisputeResolution.PARTIAL_REFUND) refundAmount = input.refundAmount ?? 0;
    if (
      input.resolution !== DisputeResolution.NO_ACTION &&
      (refundAmount > total || (input.resolution === DisputeResolution.PARTIAL_REFUND && refundAmount <= 0))
    ) {
      throw new ValidationError({ refund_amount: ['validation.refund_amount'] });
    }

    const resolution: IDispute['resolution'] = {
      type: input.resolution,
      refundAmount,
      providerAction: input.providerAction,
      suspendDays: input.providerAction === ProviderAction.SUSPEND ? (input.suspendDays ?? null) : null,
      messageToPatient: input.messageToPatient ?? null,
      messageToProvider: input.messageToProvider ?? null,
      resolvedBy: new Types.ObjectId(context.actorId!),
      resolvedAt: new Date(),
    };
    const updated = await DisputeModel.findOneAndUpdate(
      { _id: dispute._id, status: DisputeStatus.OPEN },
      { status: DisputeStatus.RESOLVED, resolution },
      { new: true, lean: true },
    );
    if (!updated) throw new ConflictError('errors.dispute_resolved');

    const providerUserId = dispute.providerProfileId
      ? (await ProviderProfileModel.findById(dispute.providerProfileId).select('userId').lean())?.userId
      : undefined;
    if (providerUserId && input.providerAction === ProviderAction.WARN) {
      await this.accounts.warn(
        String(providerUserId),
        {
          reason: input.messageToProvider ?? dispute.reasonCode,
          relatedType: 'dispute',
          relatedId: disputeId,
          notify: false,
        },
        context,
      );
    }
    if (providerUserId && input.providerAction === ProviderAction.SUSPEND) {
      await this.accounts.suspend(
        String(providerUserId),
        {
          reason: input.messageToProvider ?? dispute.reasonCode,
          durationDays: input.suspendDays ?? null,
          notify: false,
        },
        context,
      );
    }

    await this.audit.log(context, {
      action: 'dispute.resolve',
      entityType: 'dispute',
      entityId: disputeId,
      metadata: { ...input, refundAmount },
    });
    const data = { dispute_id: disputeId, booking_id: String(dispute.bookingId) };
    if (input.messageToPatient) {
      await this.notifications.notify([dispute.patientUserId], {
        type: NotificationType.DISPUTE,
        template: 'dispute_resolved',
        params: { message: input.messageToPatient },
        data,
      });
    }
    if (providerUserId && input.messageToProvider) {
      await this.notifications.notify([providerUserId], {
        type: NotificationType.DISPUTE,
        template: 'dispute_resolved',
        params: { message: input.messageToProvider },
        data,
      });
    }
    return updated;
  }
}
