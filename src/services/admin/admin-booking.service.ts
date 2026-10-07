import { Container, Service } from 'typedi';
import { Types, type FilterQuery } from 'mongoose';
import { BookingModel } from '../../database/models/booking/booking.model';
import { BookingOfferModel } from '../../database/models/booking/booking-offer.model';
import { BookingStatusHistoryModel } from '../../database/models/booking/booking-status-history.model';
import { ProviderProfileModel } from '../../database/models/provider/provider-profile.model';
import { UserModel } from '../../database/models/user/user.model';
import { UserStatus, VerificationStatus } from '../../interfaces/enums';
import {
  AssignmentMode,
  BookingActor,
  BookingStatus,
  OfferStatus,
  type IBooking,
} from '../../interfaces/IBooking';
import { escapeRegExp } from '../../utils/text/arabic';
import type { Pagination } from '../../utils/response/pagination';
import { InvalidStatusTransitionError, NotFoundError, ValidationError } from '../../utils/types-errors';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { canTransition } from '../booking/booking-state';
import {
  assertProviderFree,
  lockProviderSchedule,
  recordHistory,
  runBookingTransaction,
  transitionBooking,
} from '../booking/booking-transaction';
import { LedgerService } from '../ledger/ledger.service';

/** Admin panel bookings (spec §7.15 "Bookings & disputes"). Every write is audited. */
@Service()
export class AdminBookingService {
  private readonly audit = Container.get(AuditService);
  private readonly ledger = Container.get(LedgerService);

  async list(
    filters: { status?: BookingStatus; dateFrom?: Date; dateTo?: Date; areaId?: string; search?: string },
    pagination: Pagination,
  ) {
    const query: FilterQuery<IBooking> = {
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.areaId ? { areaId: filters.areaId } : {}),
      ...(filters.dateFrom || filters.dateTo
        ? {
            scheduledStart: {
              ...(filters.dateFrom ? { $gte: filters.dateFrom } : {}),
              ...(filters.dateTo ? { $lt: filters.dateTo } : {}),
            },
          }
        : {}),
      ...(filters.search
        ? { referenceCode: { $regex: escapeRegExp(filters.search.trim().toUpperCase()) } }
        : {}),
    };
    const [data, total] = await Promise.all([
      BookingModel.find(query)
        .sort({ scheduledStart: -1 })
        .skip(pagination.skip)
        .limit(pagination.perPage)
        .lean(),
      BookingModel.countDocuments(query),
    ]);
    return { data, total };
  }

  async detail(bookingId: string) {
    const booking = await this.get(bookingId);
    const [history, offers] = await Promise.all([
      BookingStatusHistoryModel.find({ bookingId: booking._id }).sort({ createdAt: 1 }).lean(),
      BookingOfferModel.find({ bookingId: booking._id }).lean(),
    ]);
    return { booking, history, offers };
  }

  /**
   * POST /admin/bookings/{id}/status — the moves the state machine allows an admin (cancel, no-show,
   * complete). Completing records the ledger entry like a provider completion. Disputes go through the
   * dispute flow, not here.
   */
  async forceStatus(
    bookingId: string,
    input: { status: BookingStatus; note?: string | null },
    context: AuditContext,
  ) {
    const booking = await this.get(bookingId);
    if (input.status === BookingStatus.DISPUTED)
      throw new ValidationError({ status: ['validation.use_dispute_flow'] });
    if (input.status === BookingStatus.ACCEPTED)
      throw new ValidationError({ status: ['validation.use_reassign'] });
    if (!canTransition(booking.status, input.status, BookingActor.ADMIN, booking.type)) {
      throw new InvalidStatusTransitionError();
    }
    const set: Record<string, unknown> = {};
    if (input.status === BookingStatus.CANCELLED) {
      Object.assign(set, {
        cancellationReason: { code: 'admin', text: input.note ?? null },
        cancelledBy: BookingActor.ADMIN,
      });
    }
    if (input.status === BookingStatus.COMPLETED) set.completedAt = new Date();

    const updated = await runBookingTransaction(async (tx) => {
      const result = await transitionBooking(tx, booking, input.status, BookingActor.ADMIN, {
        changedBy: context.actorId,
        set,
        note: input.note ?? 'admin',
      });
      if (input.status === BookingStatus.COMPLETED && result.providerProfileId) {
        await ProviderProfileModel.updateOne(
          { _id: result.providerProfileId },
          { $inc: { completedVisitsCount: 1 } },
          { session: tx.session },
        );
        await this.ledger.recordCompletion(result.toObject(), tx.session);
      }
      await BookingOfferModel.updateMany(
        { bookingId: booking._id, status: OfferStatus.OFFERED },
        { status: OfferStatus.EXPIRED },
        { session: tx.session },
      );
      return result;
    });
    await this.audit.log(context, {
      action: 'booking.force_status',
      entityType: 'booking',
      entityId: bookingId,
      metadata: { from: booking.status, to: input.status, note: input.note ?? null },
    });
    return updated.toObject();
  }

  /**
   * POST /admin/bookings/{id}/reassign — gives a pending or accepted booking to another approved provider
   * who offers the service and is free then; the booking becomes `accepted` on their behalf.
   */
  async reassign(bookingId: string, providerProfileId: string, context: AuditContext) {
    const booking = await this.get(bookingId);
    if (![BookingStatus.PENDING, BookingStatus.ACCEPTED].includes(booking.status)) {
      throw new InvalidStatusTransitionError();
    }
    const target = Types.ObjectId.isValid(providerProfileId)
      ? await ProviderProfileModel.findOne({
          _id: providerProfileId,
          verificationStatus: VerificationStatus.APPROVED,
        }).lean()
      : null;
    const targetUser = target
      ? await UserModel.findOne({ _id: target.userId, status: UserStatus.ACTIVE }).lean()
      : null;
    if (!target || !targetUser) throw new ValidationError({ provider_profile_id: ['validation.not_found'] });
    if (!target.services.some((s) => s.isActive && s.serviceId.equals(booking.serviceId))) {
      throw new ValidationError({ provider_profile_id: ['validation.service_unavailable'] });
    }
    if (booking.providerProfileId?.equals(target._id)) {
      throw new ValidationError({ provider_profile_id: ['validation.already_assigned'] });
    }

    const previous = booking.providerProfileId;
    const updated = await runBookingTransaction(async (tx) => {
      await lockProviderSchedule(target._id, tx.session);
      await assertProviderFree(
        target._id,
        booking.scheduledStart,
        booking.scheduledEnd,
        tx.session,
        booking._id,
      );
      const set = {
        providerProfileId: target._id,
        assignmentMode: AssignmentMode.DIRECT,
        assignmentDeadline: null,
        fallbackEndsAt: null,
      };
      let result: IBooking;
      if (booking.status === BookingStatus.PENDING) {
        result = (
          await transitionBooking(tx, booking, BookingStatus.ACCEPTED, BookingActor.ADMIN, {
            changedBy: context.actorId,
            set,
            note: 'reassigned',
            reason: 'reassigned',
          })
        ).toObject();
      } else {
        const changed = await BookingModel.findOneAndUpdate(
          { _id: booking._id, status: BookingStatus.ACCEPTED },
          { $set: set },
          { new: true, lean: true, session: tx.session },
        );
        if (!changed) throw new InvalidStatusTransitionError();
        result = changed;
        await recordHistory(
          tx,
          booking._id,
          booking.status,
          booking.status,
          BookingActor.ADMIN,
          context.actorId,
          'reassigned',
        );
        tx.publish({
          type: 'status_changed',
          booking: result,
          from: booking.status,
          to: booking.status,
          actor: BookingActor.ADMIN,
          reason: 'reassigned',
        });
      }
      await BookingOfferModel.updateMany(
        { bookingId: booking._id, status: OfferStatus.OFFERED },
        { status: OfferStatus.LOST },
        { session: tx.session },
      );
      tx.publish({ type: 'new_request', booking: result, providerProfileIds: [String(target._id)] });
      if (previous)
        tx.publish({ type: 'offer_taken', booking: result, providerProfileIds: [String(previous)] });
      return result;
    });
    await this.audit.log(context, {
      action: 'booking.reassign',
      entityType: 'booking',
      entityId: bookingId,
      metadata: { from: previous ? String(previous) : null, to: providerProfileId },
    });
    return updated;
  }

  private async get(bookingId: string) {
    const booking = Types.ObjectId.isValid(bookingId) ? await BookingModel.findById(bookingId).lean() : null;
    if (!booking) throw new NotFoundError('errors.booking_not_found');
    return booking;
  }
}
