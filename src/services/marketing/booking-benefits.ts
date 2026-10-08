import { Container } from 'typedi';
import type { ClientSession } from 'mongoose';
import { PackageSubscriptionModel } from '../../database/models/marketing/marketing.models';
import { bookingEvents, type BookingEvent } from '../../events/booking.events';
import { ACTIVE_BOOKING_STATUSES, BookingStatus, type IBooking } from '../../interfaces/IBooking';
import { logger } from '../../utils/logger/winston';
import { CreditService, creditKeptForFee } from './credit.service';
import { LedgerService } from '../ledger/ledger.service';
import { LedgerEntryType, LedgerOwnerType } from '../../interfaces/ILedger';
import { PackageService } from './package.service';
import { PromoService } from './promo.service';
import { rewardReferralSafely } from './referral.service';

/** Ends without a visit: the package visit, promo use and credit go back to the patient. */
const ENDED_WITHOUT_VISIT = [
  BookingStatus.CANCELLED,
  BookingStatus.DECLINED,
  BookingStatus.EXPIRED,
  BookingStatus.NO_SHOW,
];

/**
 * Called by `transitionBooking` inside the booking's transaction, so benefits always follow the status:
 * completed → the package visit is used; ended without a visit → visit, promo use and credit are given
 * back — minus a covered booking's travel-fee charge, which is paid to the provider. Each status change
 * happens once (conditional update), so this runs once per booking.
 */
export const settleBenefits = async (
  session: ClientSession,
  booking: IBooking,
  from: BookingStatus,
  to: BookingStatus,
) => {
  if (to === BookingStatus.COMPLETED) {
    if (booking.packageSubscriptionId) {
      await Container.get(PackageService).consume(session, booking.packageSubscriptionId);
    }
    return;
  }
  if (!ENDED_WITHOUT_VISIT.includes(to) || !ACTIVE_BOOKING_STATUSES.includes(from)) return;
  if (booking.packageSubscriptionId) {
    await Container.get(PackageService).release(session, booking.packageSubscriptionId);
  }
  if (booking.promo) await Container.get(PromoService).release(session, booking._id);
  await Container.get(CreditService).restore(booking, session);
  // A covered booking's travel-fee charge was paid with credit: the provider gets it, as with card.
  const fee = creditKeptForFee(booking);
  if (fee > 0 && booking.providerProfileId) {
    await Container.get(LedgerService).record(
      {
        ownerType: LedgerOwnerType.PROVIDER,
        ownerId: booking.providerProfileId,
        bookingId: booking._id,
        type: LedgerEntryType.CREDIT,
        amount: fee,
        note: `${booking.patientFee!.reason}: ${booking.referenceCode}`,
      },
      session,
    );
  }
};

/** After-commit side effects of a completed visit. Registered once at startup (`runServer`). */
export const registerMarketingListeners = () => {
  bookingEvents.subscribe((event) => onBookingEvent(event));
};

export const onBookingEvent = async (event: BookingEvent) => {
  if (event.type !== 'status_changed' || event.to !== BookingStatus.COMPLETED) return;
  const booking = event.booking;
  await rewardReferralSafely(booking.patientUserId);
  if (booking.packageSubscriptionId) {
    try {
      const sub = await PackageSubscriptionModel.findById(booking.packageSubscriptionId).lean();
      if (sub) await Container.get(PackageService).noticeLowVisits(sub);
    } catch (err) {
      logger.error(`Package notice failed for booking ${String(booking._id)}`, err);
    }
  }
};
