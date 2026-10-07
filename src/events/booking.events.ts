import { EventEmitter } from 'node:events';
import type { BookingActor, BookingStatus, IBooking } from '../interfaces/IBooking';
import { logger } from '../utils/logger/winston';

/**
 * Domain events for bookings, published *after* the database transaction commits. Delivery channels
 * subscribe here: sockets now (emit/booking.emit.ts), push notifications in M1.7 — booking code never
 * talks to a channel directly.
 */
export type BookingEvent =
  | {
      type: 'status_changed';
      booking: IBooking;
      from: BookingStatus | null;
      to: BookingStatus;
      actor: BookingActor;
      /** e.g. 'rescheduled', 'sent_to_other_providers'. */
      reason?: string;
    }
  /** A provider has a new request: a direct booking, or a broadcast offer. */
  | { type: 'new_request'; booking: IBooking; providerProfileIds: string[]; reason?: 'rescheduled' }
  /** Broadcast offers that are no longer available because someone else accepted. */
  | { type: 'offer_taken'; booking: IBooking; providerProfileIds: string[] };

const emitter = new EventEmitter();

export const bookingEvents = {
  publish(event: BookingEvent) {
    emitter.emit('event', event);
  },
  /** Listeners run asynchronously; their errors are logged and never reach the request. */
  subscribe(listener: (event: BookingEvent) => Promise<void> | void) {
    emitter.on('event', (event: BookingEvent) => {
      Promise.resolve()
        .then(() => listener(event))
        .catch((err: unknown) => logger.error(`Booking event listener failed (${event.type})`, err));
    });
  },
};
