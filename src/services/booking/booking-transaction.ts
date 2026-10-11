import type { ClientSession, Types } from 'mongoose';
import { BookingModel } from '../../database/models/booking/booking.model';
import { BookingStatusHistoryModel } from '../../database/models/booking/booking-status-history.model';
import { ProviderProfileModel } from '../../database/models/provider/provider-profile.model';
import { ProviderTimeOffModel } from '../../database/models/provider/provider-time-off.model';
import { withTransaction } from '../../database/transaction';
import { bookingEvents, type BookingEvent } from '../../events/booking.events';
import { DEFAULT_BREAK_MINUTES } from '../../interfaces/IProfiles';
import { addDays, cairoDate, cairoToUtc } from '../../utils/time/cairo';
import {
  ACTIVE_BOOKING_STATUSES,
  BookingType,
  type BookingActor,
  type BookingStatus,
  type IBooking,
} from '../../interfaces/IBooking';
import { InvalidStatusTransitionError, SlotUnavailableError } from '../../utils/types-errors';
import { canTransition } from './booking-state';
import { settleBenefits } from '../marketing/booking-benefits';

export type BookingTx = {
  session: ClientSession;
  /** Queue an event; it's published only after the transaction commits. */
  publish: (event: BookingEvent) => void;
};

/**
 * Runs booking work in one MongoDB transaction and publishes its events after commit. On a write
 * conflict the driver retries the whole function, so queued events are reset on every attempt.
 */
export const runBookingTransaction = async <T>(work: (tx: BookingTx) => Promise<T>): Promise<T> => {
  let events: BookingEvent[] = [];
  const result = await withTransaction((session) => {
    events = [];
    return work({ session, publish: (event) => events.push(event) });
  });
  for (const event of events) bookingEvents.publish(event);
  return result;
};

/**
 * Double-booking guard (spec §6.2). Bumps the provider's `scheduleVersion` inside the transaction, so two
 * transactions booking the same provider always write the same document: one wins, the other gets a
 * write conflict, is retried by the driver, and then sees the winner's booking in `assertProviderFree`.
 * Call it before `assertProviderFree`.
 */
export const lockProviderSchedule = (providerProfileId: Types.ObjectId | string, session: ClientSession) =>
  ProviderProfileModel.updateOne({ _id: providerProfileId }, { $inc: { scheduleVersion: 1 } }, { session });

/** 409 SLOT_UNAVAILABLE if the provider has another active booking or time off overlapping [start, end). */
export const assertProviderFree = async (
  providerProfileId: Types.ObjectId | string,
  start: Date,
  end: Date,
  session: ClientSession,
  excludeBookingId?: Types.ObjectId | string,
  /** The visit being placed: home visits also count toward the provider's daily maximum. */
  visitType: BookingType = BookingType.HOME_VISIT,
) => {
  const rules = await ProviderProfileModel.findById(providerProfileId)
    .select('breakMinutes maxVisitsPerDay')
    .session(session)
    .lean();
  // Existing home visits keep the provider's break free on both sides (same rule as busyIntervals).
  const pad = (rules?.breakMinutes ?? DEFAULT_BREAK_MINUTES) * 60_000;
  const others = excludeBookingId ? { _id: { $ne: excludeBookingId } } : {};
  const [booking, timeOff] = await Promise.all([
    BookingModel.exists({
      providerProfileId,
      status: { $in: ACTIVE_BOOKING_STATUSES },
      ...others,
      $or: [
        {
          type: { $ne: BookingType.CLINIC_VISIT },
          scheduledStart: { $lt: new Date(end.getTime() + pad) },
          scheduledEnd: { $gt: new Date(start.getTime() - pad) },
        },
        { type: BookingType.CLINIC_VISIT, scheduledStart: { $lt: end }, scheduledEnd: { $gt: start } },
      ],
    }).session(session),
    ProviderTimeOffModel.exists({
      providerProfileId,
      startsAt: { $lt: end },
      endsAt: { $gt: start },
    }).session(session),
  ]);
  if (booking || timeOff) throw new SlotUnavailableError();
  if (visitType !== BookingType.CLINIC_VISIT && rules?.maxVisitsPerDay) {
    const day = cairoDate(start);
    const sameDay = await BookingModel.countDocuments({
      providerProfileId,
      status: { $in: ACTIVE_BOOKING_STATUSES },
      type: { $ne: BookingType.CLINIC_VISIT },
      scheduledStart: { $gte: cairoToUtc(day, '00:00'), $lt: cairoToUtc(addDays(day, 1), '00:00') },
      ...others,
    }).session(session);
    if (sameDay >= rules.maxVisitsPerDay) throw new SlotUnavailableError();
  }
};

/**
 * The only way a booking's status changes (spec §5): checks the state machine, updates conditionally on
 * the status the caller saw (so a concurrent change → 409, never a lost update), appends the history
 * row, and queues the `status_changed` event.
 */
export const transitionBooking = async (
  tx: BookingTx,
  booking: IBooking,
  to: BookingStatus,
  actor: BookingActor,
  options: {
    changedBy?: string | null;
    set?: Record<string, unknown>;
    note?: string | null;
    /** Extra conditions for the update, e.g. `{ providerProfileId }`. */
    where?: Record<string, unknown>;
    reason?: string;
  } = {},
) => {
  if (!canTransition(booking.status, to, actor, booking.type)) throw new InvalidStatusTransitionError();
  const updated = await BookingModel.findOneAndUpdate(
    { _id: booking._id, status: booking.status, ...options.where },
    { $set: { status: to, ...options.set } },
    { new: true, session: tx.session },
  );
  if (!updated) throw new InvalidStatusTransitionError();
  await settleBenefits(tx.session, updated.toObject(), booking.status, to);
  await recordHistory(
    tx,
    updated._id,
    booking.status,
    to,
    actor,
    options.changedBy ?? null,
    options.note ?? null,
  );
  tx.publish({
    type: 'status_changed',
    booking: updated.toObject(),
    from: booking.status,
    to,
    actor,
    reason: options.reason,
  });
  return updated;
};

export const recordHistory = (
  tx: BookingTx,
  bookingId: Types.ObjectId,
  from: BookingStatus | null,
  to: BookingStatus,
  actor: BookingActor,
  changedBy: string | null,
  note: string | null,
  internalReason: { code: string; text: string | null } | null = null,
) =>
  BookingStatusHistoryModel.create(
    [{ bookingId, fromStatus: from, toStatus: to, actor, changedBy, note, internalReason }],
    { session: tx.session },
  );
