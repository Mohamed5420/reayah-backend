import { Container, Service } from 'typedi';
import type { Types } from 'mongoose';
import { BookingModel } from '../../database/models/booking/booking.model';
import { BookingOfferModel } from '../../database/models/booking/booking-offer.model';
import {
  AssignmentMode,
  BookingActor,
  BookingStatus,
  OfferStatus,
  PreferredGender,
  type IBooking,
} from '../../interfaces/IBooking';
import type { Gender } from '../../interfaces/enums';
import { logger } from '../../utils/logger/winston';
import { cairoDate, cairoOffsetMinutes, fromMinutes } from '../../utils/time/cairo';
import { DiscoveryService, ProviderSort } from '../discovery/discovery.service';
import { overlaps } from '../discovery/slot-engine';
import { SettingsService } from '../settings/settings.service';
import { recordHistory, runBookingTransaction, transitionBooking } from './booking-transaction';

/** How many overdue bookings one sweep handles; the next sweep picks up the rest. */
const BATCH = 100;

/**
 * Booking deadlines (spec §6.9a, §6.10), run every 30 s by the maintenance queue — no per-booking
 * timers, so nothing needs cancelling when a booking is accepted or rescheduled, and a missed run
 * just catches up. Every handler re-checks the booking's state, so running twice is harmless.
 *
 * - Direct request not answered by `assignmentDeadline` → broadcast to other eligible independent
 *   providers for `fallback_window_minutes` (if the patient allowed fallback), else expired.
 * - Broadcast nobody accepted by `fallbackEndsAt` → expired; open offers expire.
 */
@Service()
export class BookingDeadlineService {
  private readonly discovery = Container.get(DiscoveryService);
  private readonly settings = Container.get(SettingsService);

  async processDue(now = new Date()) {
    const direct = await BookingModel.find({
      status: BookingStatus.PENDING,
      assignmentMode: AssignmentMode.DIRECT,
      assignmentDeadline: { $lte: now },
    })
      .limit(BATCH)
      .lean();
    for (const booking of direct) {
      await this.handleDirectTimeout(booking, now).catch((err: unknown) =>
        logger.error(`Direct timeout failed for booking ${String(booking._id)}`, err),
      );
    }

    const broadcasts = await BookingModel.find({
      status: BookingStatus.PENDING,
      assignmentMode: AssignmentMode.BROADCAST,
      fallbackEndsAt: { $lte: now },
    })
      .limit(BATCH)
      .lean();
    for (const booking of broadcasts) {
      await this.expire(booking, { assignmentMode: AssignmentMode.BROADCAST }).catch((err: unknown) =>
        logger.error(`Broadcast expiry failed for booking ${String(booking._id)}`, err),
      );
    }
    return { direct: direct.length, broadcasts: broadcasts.length };
  }

  private async handleDirectTimeout(booking: IBooking, now: Date) {
    const original = booking.providerProfileId!;
    const candidates = booking.allowFallback ? await this.fallbackCandidates(booking, original) : [];
    if (!candidates.length) {
      await this.expire(booking, { assignmentMode: AssignmentMode.DIRECT, providerProfileId: original });
      return;
    }

    const fallbackEndsAt = new Date(
      now.getTime() + (await this.settings.get('fallback_window_minutes')) * 60_000,
    );
    await runBookingTransaction(async (tx) => {
      const updated = await BookingModel.findOneAndUpdate(
        {
          _id: booking._id,
          status: BookingStatus.PENDING,
          assignmentMode: AssignmentMode.DIRECT,
          providerProfileId: original,
        },
        {
          $set: {
            providerProfileId: null,
            assignmentMode: AssignmentMode.BROADCAST,
            assignmentDeadline: null,
            fallbackEndsAt,
          },
        },
        { new: true, session: tx.session, lean: true },
      );
      if (!updated) return; // accepted or cancelled in the meantime
      await BookingOfferModel.insertMany(
        candidates.map((providerProfileId) => ({
          bookingId: booking._id,
          providerProfileId,
          expiresAt: fallbackEndsAt,
        })),
        { session: tx.session },
      );
      await recordHistory(
        tx,
        booking._id,
        booking.status,
        booking.status,
        BookingActor.SYSTEM,
        null,
        'sent_to_other_providers',
      );
      tx.publish({
        type: 'status_changed',
        booking: updated,
        from: booking.status,
        to: booking.status,
        actor: BookingActor.SYSTEM,
        reason: 'sent_to_other_providers',
      });
      // The first provider can no longer accept; everyone else has a new request.
      tx.publish({ type: 'offer_taken', booking: updated, providerProfileIds: [String(original)] });
      tx.publish({ type: 'new_request', booking: updated, providerProfileIds: candidates.map(String) });
    });
  }

  /**
   * Independent providers who match like a search would (area, service, preferred gender, a free slot
   * at the booked time) and are free for the whole booked duration — excluding the provider who didn't answer.
   * They're offered the price the patient already accepted.
   */
  private async fallbackCandidates(booking: IBooking, exclude: Types.ObjectId) {
    const date = cairoDate(booking.scheduledStart);
    const localMinutes =
      (booking.scheduledStart.getUTCHours() * 60 +
        booking.scheduledStart.getUTCMinutes() +
        cairoOffsetMinutes(booking.scheduledStart)) %
      (24 * 60);
    try {
      const { data } = await this.discovery.search(
        {
          serviceId: String(booking.serviceId),
          areaId: String(booking.areaId),
          date,
          time: fromMinutes(localMinutes),
          gender:
            booking.preferredGender === PreferredGender.ANY
              ? undefined
              : (booking.preferredGender as unknown as Gender),
          source: 'independent',
          sort: ProviderSort.RATING,
        },
        { page: 1, perPage: 500, skip: 0 },
      );
      const ids = data.map((c) => c.profile._id).filter((id) => !id.equals(exclude));
      const busy = await this.discovery.busyIntervals(
        ids,
        booking.scheduledStart,
        booking.scheduledEnd,
        String(booking._id),
      );
      return ids.filter(
        (id) =>
          !(busy.get(String(id)) ?? []).some((b) =>
            overlaps(b, { start: booking.scheduledStart, end: booking.scheduledEnd }),
          ),
      );
    } catch (err) {
      // e.g. the area or service was deactivated since — nobody to send it to.
      logger.warn(`No fallback for booking ${String(booking._id)}: ${(err as Error).message}`);
      return [];
    }
  }

  private async expire(booking: IBooking, where: Record<string, unknown>) {
    await runBookingTransaction(async (tx) => {
      await transitionBooking(tx, booking, BookingStatus.EXPIRED, BookingActor.SYSTEM, {
        where,
        note: 'nobody_accepted',
      });
      await BookingOfferModel.updateMany(
        { bookingId: booking._id, status: OfferStatus.OFFERED },
        { status: OfferStatus.EXPIRED },
        { session: tx.session },
      );
    });
  }
}
