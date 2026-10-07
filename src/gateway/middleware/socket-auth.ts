import type { Socket } from 'socket.io';
import type { IAuthUser } from '../../interfaces/IUser';
import { verifyAccessToken } from '../../services/auth/jwt';

export type AuthedSocket = Socket & { data: { user: IAuthUser } };

/**
 * Accepts the access token from `auth.token` or the `Authorization: Bearer` header.
 * On an expired token the client gets `TOKEN_EXPIRED` and should refresh, then reconnect.
 */
export const socketAuth = (socket: Socket, next: (err?: Error) => void) => {
  const raw =
    (socket.handshake.auth?.token as string | undefined) ??
    socket.handshake.headers.authorization?.replace(/^Bearer\s+/i, '');

  if (!raw) return next(new Error('UNAUTHENTICATED'));

  try {
    socket.data.user = verifyAccessToken(raw);
    next();
  } catch (err) {
    next(new Error((err as { code?: string }).code ?? 'UNAUTHENTICATED'));
  }
};
