import { Container } from 'typedi';
import { bookingEvents, type BookingEvent } from '../../events/booking.events';
import { BookingStatus, PaymentStatus } from '../../interfaces/IBooking';
import { logger } from '../../utils/logger/winston';
import { PaymentService } from './payment.service';

const REFUNDED_ON = [BookingStatus.CANCELLED, BookingStatus.DECLINED, BookingStatus.EXPIRED];

/**
 * A paid card / wallet booking that ends without a visit (cancelled by anyone, declined, expired) is
 * refunded in full. Subscribed once at startup (`runServer`), like the other booking listeners.
 */
export const registerPaymentRefunds = () => {
  bookingEvents.subscribe((event) => refundIfNeeded(event));
};

export const refundIfNeeded = async (event: BookingEvent) => {
  if (event.type !== 'status_changed' || !REFUNDED_ON.includes(event.to)) return;
  if (event.booking.paymentStatus !== PaymentStatus.PAID) return;
  try {
    await Container.get(PaymentService).refundBooking(
      event.booking._id,
      { amount: null, reason: `booking_${event.to}` },
      null,
    );
  } catch (err) {
    // Shows up in logs/Sentry; an admin can retry from POST /admin/bookings/{id}/refund.
    logger.error(`Automatic refund failed for booking ${String(event.booking._id)}`, err);
  }
};
