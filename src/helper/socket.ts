import type { Server as IOServer } from 'socket.io';

let io: IOServer | null = null;

export const setIO = (instance: IOServer) => {
  io = instance;
};

/** Access the Socket.IO server from anywhere (services, emitters, workers). */
export const getIO = (): IOServer => {
  if (!io) throw new Error('Socket.IO not initialized — call socketIOHandler() first');
  return io;
};

/** The Socket.IO server, or null when it isn't running (tests, scripts, background-only processes). */
export const getIOIfReady = (): IOServer | null => io;

export const userRoom = (userId: string) => `user:${userId}`;

/** Spec §7.12 `booking.{id}` channel — joined explicitly, participants only (see booking.gateway.ts). */
export const bookingRoom = (bookingId: string) => `booking:${bookingId}`;
