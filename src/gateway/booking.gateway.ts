import type { Server } from 'socket.io';
import { Types } from 'mongoose';
import { BookingModel } from '../database/models/booking/booking.model';
import { ProviderProfileModel } from '../database/models/provider/provider-profile.model';
import type { IAuthUser } from '../interfaces/IUser';
import { BookingStatus } from '../interfaces/IBooking';
import { bookingRoom } from '../helper/socket';
import type { AuthedSocket } from './middleware/socket-auth';
import { logger } from '../utils/logger/winston';

/** Only the booking's patient and its currently assigned provider may follow it live. */
export const canFollowBooking = async (user: IAuthUser, bookingId: string) => {
  if (!Types.ObjectId.isValid(bookingId)) return false;
  const booking = await BookingModel.findById(bookingId)
    .select('patientUserId providerProfileId status')
    .lean();
  if (!booking) return false;
  if (String(booking.patientUserId) === user.id) return true;
  // Providers don't see a card / wallet booking until it's paid.
  if (!booking.providerProfileId || booking.status === BookingStatus.AWAITING_PAYMENT) return false;
  const profile = await ProviderProfileModel.findById(booking.providerProfileId).select('userId').lean();
  return String(profile?.userId) === user.id;
};

/**
 * `booking.{id}` rooms (spec §7.12). The app opens a booking screen and emits
 * `booking:subscribe` `{ booking_id }`; the ack says whether it was allowed. Updates for that booking
 * then arrive there as well as on the user's own room (Socket.IO delivers each event once per socket).
 */
export const registerBookingGateway = (io: Server) => {
  io.of('/').on('connection', (socket) => {
    const user = (socket as AuthedSocket).data.user;

    socket.on(
      'booking:subscribe',
      async (payload: { booking_id?: string }, ack?: (r: { ok: boolean }) => void) => {
        try {
          const bookingId = String(payload?.booking_id ?? '');
          const ok = await canFollowBooking(user, bookingId);
          if (ok) await socket.join(bookingRoom(bookingId));
          ack?.({ ok });
        } catch (err) {
          logger.error('booking:subscribe failed', err);
          ack?.({ ok: false });
        }
      },
    );

    socket.on('booking:unsubscribe', async (payload: { booking_id?: string }) => {
      await socket.leave(bookingRoom(String(payload?.booking_id ?? '')));
    });
  });
};
