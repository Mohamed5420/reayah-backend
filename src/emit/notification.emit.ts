import { getIOIfReady, userRoom } from '../helper/socket';

/** Spec §7.12: the `user.{id}` channel's event. */
export const SocketEvents = {
  NOTIFICATION: 'notification.new',
} as const;

/** Live inbox update to all of the user's connected apps. No-op when sockets aren't running. */
export const emitNotificationToUser = (userId: string, payload: Record<string, unknown>) => {
  getIOIfReady()?.to(userRoom(userId)).emit(SocketEvents.NOTIFICATION, payload);
};
