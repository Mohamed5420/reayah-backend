import { ProviderProfileModel } from '../database/models/provider/provider-profile.model';
import { bookingEvents } from '../events/booking.events';
import { bookingRoom, getIOIfReady, userRoom } from '../helper/socket';

/** Socket event names (spec §7.12). */
export const BookingSocketEvents = {
  STATUS_CHANGED: 'booking.status_changed',
  NEW_REQUEST: 'booking.new_request',
  OFFER_TAKEN: 'booking.offer_taken',
} as const;

const providerUserIds = async (providerProfileIds: string[]) =>
  (
    await ProviderProfileModel.find({ _id: { $in: providerProfileIds } })
      .select('userId')
      .lean()
  ).map((p) => String(p.userId));

/**
 * Real-time updates to both parties' `user:<id>` rooms. The timeline in GET /bookings/{id} stays the
 * source of truth; sockets only tell the apps to refresh. No location data — ever (spec §1).
 */
export const registerBookingSocketEvents = () => {
  bookingEvents.subscribe(async (event) => {
    const io = getIOIfReady();
    if (!io) return;
    const bookingId = String(event.booking._id);

    if (event.type === 'status_changed') {
      const recipients = [String(event.booking.patientUserId)];
      if (event.booking.providerProfileId) {
        recipients.push(...(await providerUserIds([String(event.booking.providerProfileId)])));
      }
      io.to([...recipients.map(userRoom), bookingRoom(bookingId)]).emit(BookingSocketEvents.STATUS_CHANGED, {
        event: BookingSocketEvents.STATUS_CHANGED,
        booking_id: bookingId,
        from: event.from,
        to: event.to,
        at: new Date().toISOString(),
      });
      return;
    }

    const users = await providerUserIds(event.providerProfileIds);
    const name =
      event.type === 'new_request' ? BookingSocketEvents.NEW_REQUEST : BookingSocketEvents.OFFER_TAKEN;
    io.to(users.map(userRoom)).emit(name, { event: name, booking_id: bookingId });
  });
};
