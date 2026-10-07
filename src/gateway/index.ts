import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { env } from '../config/env.config';
import { setIO } from '../helper/socket';
import { registerUserGateway } from './user.gateway';
import { registerBookingGateway } from './booking.gateway';
import { logger } from '../utils/logger/winston';

export const socketIOHandler = (httpServer: HttpServer) => {
  const io = new Server(httpServer, {
    cors: { origin: env.corsOrigins === '*' ? '*' : env.corsOrigins.split(',') },
  });

  setIO(io);

  // Register one gateway per namespace/domain here.
  registerUserGateway(io);
  registerBookingGateway(io);

  logger.info('Socket.IO ready');
  return io;
};
