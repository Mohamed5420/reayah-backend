import type { Server } from 'socket.io';
import { Container } from 'typedi';
import { socketAuth, type AuthedSocket } from './middleware/socket-auth';
import { userRoom } from '../helper/socket';
import { UserService } from '../services/user';
import { logger } from '../utils/logger/winston';

/** Default namespace: presence + per-user room for targeted emits. */
export const registerUserGateway = (io: Server) => {
  const nsp = io.of('/');
  nsp.use(socketAuth);

  nsp.on('connection', async (socket) => {
    const { id: userId } = (socket as AuthedSocket).data.user;
    const userService = Container.get(UserService);

    await socket.join(userRoom(userId));
    await userService.setOnline(userId, true).catch((err) => logger.error('setOnline failed', err));

    socket.on('disconnect', async () => {
      // Only mark offline when the user's last socket closes (multiple devices/tabs).
      const remaining = await nsp.in(userRoom(userId)).fetchSockets();
      if (remaining.length === 0) {
        await userService.setOnline(userId, false).catch((err) => logger.error('setOffline failed', err));
      }
    });
  });
};
