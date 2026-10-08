import { Container, Service } from 'typedi';
import { CommissionService } from '../payouts/commission.service';
import type { Types } from 'mongoose';
import { BookingModel } from '../../database/models/booking/booking.model';
import { BookingOfferModel } from '../../database/models/booking/booking-offer.model';
import {
  AssignmentMode,
  BookingActor,
  BookingStatus,
  OfferStatus,
  PaymentMethod,
  PreferredGender,
  type IBooking,
} from '../../interfaces/IBooking';
import type { Gender } from '../../interfaces/enums';
import { logger } from '../../utils/logger/winston';
import { cairoDate, cairoOffsetMinutes, fromMinutes } from '../../utils/time/cairo';
import { DiscoveryService, ProviderSort } from '../discovery/discovery.service';
import { overlaps } from '../discovery/slot-engine';
import { SettingsService } from '../settings/settings.service';
import { OrganizationModel } from '../../database/models/organization/organization.models';
import { VerificationStatus } from '../../interfaces/enums';
import { LedgerOwnerType } from '../../interfaces/ILedger';
import { NotificationType } from '../../interfaces/INotification';
import { NotificationService } from '../notification/notification.service';
import { bookingParams, ownerUserIds } from '../notification/booking-notifications';
import { OrgDiscoveryService } from '../organization/org-discovery.service';
import { sameWorld } from '../auth/test-accounts';
import { recordHistory, runBookingTransaction, transitionBooking } from './booking-transaction';

/** Spec §6.6: the owner is warned this long before the assignment deadline. */
export const ORG_DEADLINE_WARNING_MINUTES = 10;

/** How many overdue bookings one sweep handles; the next sweep picks up the rest. */
const BATCH = 100;

/**
 * Booking deadlines (spec §6.9a, §6.10), run every 30 s by the maintenance queue — no per-booking
 * timers, so nothing needs cancelling when a booking is accepted or rescheduled, and a missed run
 * just catches up. Every handler re-checks the booking's state, so running twice is harmless.
 *
 * - Direct request not answered, or organization request not assigned, by `assignmentDeadline` →
 *   offered to other eligible independent providers and organizations for `fallback_window_minutes`
 *   (if the patient allowed fallback), else expired. Owners are warned 10 minutes before.
 * - Broadcast nobody accepted by `fallbackEndsAt` → expired; open offers expire.
 */
@Service()
export class BookingDeadlineService {
  private readonly discovery = Container.get(DiscoveryService);
  private readonly settings = Container.get(SettingsService);

  async processDue(now = new Date()) {
    // Direct requests the provider didn't answer, and organization requests the owner didn't assign.
    const overdue = await BookingModel.find({
      status: BookingStatus.PENDING,
      $or: [
        { assignmentMode: AssignmentMode.DIRECT },
        { assignmentMode: AssignmentMode.ORGANIZATION, providerProfileId: null },
      ],
      assignmentDeadline: { $lte: now },
    })
      .limit(BATCH)
      .lean();
    for (const booking of overdue) {
      await this.handleTimeout(booking, now).catch((err: unknown) =>
        logger.error(`Deadline timeout failed for booking ${String(booking._id)}`, err),
      );
    }

    await this.warnOwners(now);

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
    return { direct: overdue.length, broadcasts: broadcasts.length };
  }

  /**
   * An organization's owner declined their own request: straight to the fallback. false = nobody to
   * send it to (the caller then declines it).
   */
  moveToFallback(booking: IBooking) {
    return this.startFallback(booking, new Date());
  }

  private async handleTimeout(booking: IBooking, now: Date) {
    const started = booking.allowFallback && (await this.startFallback(booking, now));
    if (started) return;
    await this.expire(
      booking,
      booking.assignmentMode === AssignmentMode.DIRECT
        ? { assignmentMode: AssignmentMode.DIRECT, providerProfileId: booking.providerProfileId }
        : { assignmentMode: AssignmentMode.ORGANIZATION, providerProfileId: null },
    );
  }

  /**
   * Spec §6.10: the request is offered for `fallback_window_minutes` to other eligible independent
   * providers and organizations in the area (first to accept wins; organizations take it by assigning
   * a free staff member). false = nobody to offer it to.
   */
  private async startFallback(booking: IBooking, now: Date) {
    const original = booking.assignmentMode === AssignmentMode.DIRECT ? booking.providerProfileId : null;
    const [providers, orgs] = await Promise.all([
      this.fallbackCandidates(booking, original),
      this.organizationCandidates(booking),
    ]);
    if (!providers.length && !orgs.length) return false;

    const fallbackEndsAt = new Date(
      now.getTime() + (await this.settings.get('fallback_window_minutes')) * 60_000,
    );
    await runBookingTransaction(async (tx) => {
      const updated = await BookingModel.findOneAndUpdate(
        {
          _id: booking._id,
          status: BookingStatus.PENDING,
          assignmentMode: booking.assignmentMode,
          providerProfileId: booking.providerProfileId,
        },
        {
          $set: {
            providerProfileId: null,
            // organizationId stays until someone takes it: the original organization still sees it in its
            // list (and gets ASSIGNMENT_DEADLINE_PASSED if it tries to assign); expired = missed by them.
            assignmentMode: AssignmentMode.BROADCAST,
            assignmentDeadline: null,
            fallbackEndsAt,
          },
        },
        { new: true, session: tx.session, lean: true },
      );
      if (!updated) return; // accepted or cancelled in the meantime
      // The original organization's own "send to all" offers end here.
      const lapsed = await BookingOfferModel.find({
        bookingId: booking._id,
        status: OfferStatus.OFFERED,
      }).session(tx.session);
      await BookingOfferModel.updateMany(
        { _id: { $in: lapsed.map((o) => o._id) } },
        { status: OfferStatus.EXPIRED },
        { session: tx.session },
      );
      await BookingOfferModel.insertMany(
        [
          ...providers.map((providerProfileId) => ({
            bookingId: booking._id,
            providerProfileId,
            expiresAt: fallbackEndsAt,
          })),
          ...orgs.map((organizationId) => ({
            bookingId: booking._id,
            organizationId,
            providerProfileId: null,
            expiresAt: fallbackEndsAt,
          })),
        ],
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
      // Whoever had it can no longer take it; everyone else has a new request.
      const lost = [
        ...(original ? [String(original)] : []),
        ...lapsed.flatMap((o) => (o.providerProfileId ? [String(o.providerProfileId)] : [])),
      ];
      if (lost.length) tx.publish({ type: 'offer_taken', booking: updated, providerProfileIds: lost });
      if (providers.length) {
        tx.publish({ type: 'new_request', booking: updated, providerProfileIds: providers.map(String) });
      }
      if (orgs.length) {
        tx.publish({
          type: 'org_request',
          booking: updated,
          organizationIds: orgs.map(String),
          reason: 'offer',
        });
      }
    });
    return true;
  }

  /**
   * Other approved organizations serving the area and offering the service with at least one eligible
   * staff member free at the booked time (and, for cash, not over the commission limit).
   */
  private async organizationCandidates(booking: IBooking) {
    try {
      const orgs = Container.get(OrgDiscoveryService);
      const candidates = await OrganizationModel.find({
        verificationStatus: VerificationStatus.APPROVED,
        ...(booking.organizationId ? { _id: { $ne: booking.organizationId } } : {}),
        ...sameWorld(booking.isTestAccount),
        serviceAreas: { $elemMatch: { areaId: booking.areaId, isActive: true } },
        services: { $elemMatch: { serviceId: booking.serviceId, isActive: true } },
      })
        .select('_id')
        .lean();
      const service = await orgs.serviceRowFor(booking);
      const gender =
        booking.preferredGender === PreferredGender.ANY
          ? null
          : (booking.preferredGender as unknown as Gender);
      let ids: Types.ObjectId[] = [];
      for (const { _id } of candidates) {
        const staff = await orgs.eligibleStaff(_id, {
          serviceId: String(booking.serviceId),
          areaId: String(booking.areaId),
          gender,
        });
        const free = await orgs.freeAt(
          staff,
          service,
          booking.scheduledStart,
          booking.quantity,
          String(booking._id),
        );
        if (free.length) ids.push(_id);
      }
      if (booking.paymentMethod === PaymentMethod.CASH && ids.length) {
        const blocked = await Container.get(CommissionService).overLimitAmong(
          ids,
          LedgerOwnerType.ORGANIZATION,
        );
        ids = ids.filter((id) => !blocked.has(String(id)));
      }
      return ids;
    } catch (err) {
      logger.warn(`No organization fallback for booking ${String(booking._id)}: ${(err as Error).message}`);
      return [];
    }
  }

  /** "10 minutes left to assign" — once per booking, to the organization's owner. */
  private async warnOwners(now: Date) {
    const soon = await BookingModel.find({
      status: BookingStatus.PENDING,
      assignmentMode: AssignmentMode.ORGANIZATION,
      providerProfileId: null,
      deadlineWarningAt: null,
      assignmentDeadline: { $gt: now, $lte: new Date(now.getTime() + ORG_DEADLINE_WARNING_MINUTES * 60_000) },
    })
      .limit(BATCH)
      .lean();
    for (const booking of soon) {
      const claimed = await BookingModel.updateOne(
        { _id: booking._id, deadlineWarningAt: null },
        { deadlineWarningAt: now },
      );
      if (!claimed.modifiedCount || !booking.organizationId) continue;
      await Container.get(NotificationService)
        .notify(await ownerUserIds([String(booking.organizationId)]), {
          type: NotificationType.ASSIGNMENT_DEADLINE_WARNING,
          template: 'org_deadline_warning',
          params: await bookingParams(booking),
          data: { booking_id: String(booking._id) },
        })
        .catch((err: unknown) => logger.error(`Deadline warning failed for ${String(booking._id)}`, err));
    }
  }

  /**
   * Independent providers who match like a search would (area, service, preferred gender, a free slot
   * at the booked time) and are free for the whole booked duration — excluding the provider who didn't answer.
   * They're offered the price the patient already accepted.
   */
  private async fallbackCandidates(booking: IBooking, exclude: Types.ObjectId | null) {
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
          testAccount: booking.isTestAccount,
        },
        { page: 1, perPage: 500, skip: 0 },
      );
      let ids = data.map((c) => c.profile._id).filter((id) => !exclude || !id.equals(exclude));
      // Cash requests don't go to providers over the commission limit.
      if (booking.paymentMethod === PaymentMethod.CASH) {
        const blocked = await Container.get(CommissionService).overLimitAmong(ids);
        ids = ids.filter((id) => !blocked.has(String(id)));
      }
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
