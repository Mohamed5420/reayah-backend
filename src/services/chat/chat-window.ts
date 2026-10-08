import { BookingStatus, type IBooking } from '../../interfaces/IBooking';

/** Chat stays open this long after the visit is completed (spec §7.12). */
export const CHAT_HOURS_AFTER_COMPLETION = 24;

const OPEN_STATUSES = [BookingStatus.ACCEPTED, BookingStatus.ON_THE_WAY, BookingStatus.IN_PROGRESS];

/** Sending is allowed from `accepted` until 24 h after `completed`; reading the history stays allowed. */
export const chatOpen = (booking: Pick<IBooking, 'status' | 'completedAt'>, now = new Date()) =>
  OPEN_STATUSES.includes(booking.status) ||
  (booking.status === BookingStatus.COMPLETED &&
    !!booking.completedAt &&
    now.getTime() - booking.completedAt.getTime() <= CHAT_HOURS_AFTER_COMPLETION * 3600_000);
