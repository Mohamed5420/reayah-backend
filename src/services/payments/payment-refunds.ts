import { Container } from 'typedi';
import { withTransaction } from '../../database/transaction';
import { bookingEvents, type BookingEvent } from '../../events/booking.events';
import { BookingStatus, GATEWAY_PAYMENT_METHODS, PaymentStatus } from '../../interfaces/IBooking';
import { LedgerEntryType, LedgerOwnerType } from '../../interfaces/ILedger';
import { logger } from '../../utils/logger/winston';
import { LedgerService } from '../ledger/ledger.service';
import { PaymentService } from './payment.service';

const REFUNDED_ON = [
  BookingStatus.CANCELLED,
  BookingStatus.DECLINED,
  BookingStatus.EXPIRED,
  BookingStatus.NO_SHOW,
];

/**
 * A paid card / wallet booking that ends without a visit (cancelled by anyone, declined, expired,
 * no-show) is refunded — minus the patient's travel-fee charge when one applies (cancelled after
 * "on the way", or a no-show), which is credited to the provider instead. Subscribed once at startup.
 */
export const registerPaymentRefunds = () => {
  bookingEvents.subscribe((event) => refundIfNeeded(event));
};

export const refundIfNeeded = async (event: BookingEvent) => {
  if (event.type !== 'status_changed' || !REFUNDED_ON.includes(event.to)) return;
  const booking = event.booking;
  if (
    booking.paymentStatus !== PaymentStatus.PAID ||
    !GATEWAY_PAYMENT_METHODS.includes(booking.paymentMethod)
  ) {
    return; // covered bookings give back their package visit / credit instead (settleBenefits)
  }
  const fee = booking.patientFee?.collected ? booking.patientFee.amount : 0;
  try {
    if (booking.price.total - fee > 0) {
      await Container.get(PaymentService).refundBooking(
        booking._id,
        { amount: booking.price.total - fee, reason: `booking_${event.to}` },
        null,
      );
    }
    if (fee > 0 && booking.providerProfileId) {
      const providerProfileId = booking.providerProfileId;
      await withTransaction((session) =>
        Container.get(LedgerService).record(
          {
            ownerType: LedgerOwnerType.PROVIDER,
            ownerId: providerProfileId,
            bookingId: booking._id,
            type: LedgerEntryType.CREDIT,
            amount: fee,
            note: `${booking.patientFee!.reason}: ${booking.referenceCode}`,
          },
          session,
        ),
      );
    }
  } catch (err) {
    // Shows up in logs/Sentry; an admin can retry from POST /admin/bookings/{id}/refund.
    logger.error(`Automatic refund failed for booking ${String(booking._id)}`, err);
  }
};
