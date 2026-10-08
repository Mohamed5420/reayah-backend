import { bookingRoom, getIOIfReady, userRoom } from '../helper/socket';
import type { AuthedSocket } from '../gateway/middleware/socket-auth';
import { presentMessage } from '../api/presenters/chat.presenter';
import type { MessageView } from '../services/chat/chat.service';

/** Chat socket events (spec §7.12, `booking.{id}` channel). */
export const ChatSocketEvents = {
  NEW: 'message.new',
  READ: 'message.read',
} as const;

/**
 * Sends a chat event to the booking's room and to both participants' own rooms, so an open chat
 * updates live and the conversation list can refresh. Socket.IO delivers it once per socket.
 */
export const emitChatEvent = (
  bookingId: string,
  participantUserIds: Array<string | null>,
  event: (typeof ChatSocketEvents)[keyof typeof ChatSocketEvents],
  payload: MessageView | Record<string, unknown>,
) => {
  const io = getIOIfReady();
  if (!io) return;
  const rooms = [
    bookingRoom(bookingId),
    ...participantUserIds.filter((id): id is string => !!id).map(userRoom),
  ];
  const body = event === ChatSocketEvents.NEW ? { message: presentMessage(payload as MessageView) } : payload;
  io.to(rooms).emit(event, { event, booking_id: bookingId, ...body });
};

/** True when the user has this booking's chat open right now (then no push is needed). */
export const isViewingBooking = async (bookingId: string, userId: string) => {
  const io = getIOIfReady();
  if (!io) return false;
  const sockets = await io.in(bookingRoom(bookingId)).fetchSockets();
  return sockets.some((s) => (s as unknown as AuthedSocket).data.user?.id === userId);
};
