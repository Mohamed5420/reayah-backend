import http from 'node:http';
import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { env } from './config/env.config';
import { initFirebase, sendTopicMessage } from './config/firebase.config';
import { connectDB, runSeeds } from './database';
import type IBaseController from './api/controllers/interfaces/base-controller.interface';
import { standaloneRouters } from './api/routers';
import {
  GlobalErrorHandlerMiddleware,
  NotFoundMiddleware,
  RateLimiterMiddleware,
  RequestLoggerMiddleware,
} from './api/middlewares/app';
import { socketIOHandler } from './gateway';
import { registerBookingSocketEvents } from './emit/booking.emit';
import { registerBookingNotifications } from './services/notification/booking-notifications';
import { registerPaymentRefunds } from './services/payments/payment-refunds';
import { getIO } from './helper/socket';
import { initQueues } from './queues/queue-registry';
import { initializeBullBoard } from './queues/bull-board';
import { logger } from './utils/logger/winston';
import { RequestIdMiddleware } from './utils/request-context';
import { mountApiDocs } from './docs/serve-docs';

export class Server {
  readonly app: Express;
  readonly httpServer: http.Server;

  constructor(private readonly controllers: IBaseController[]) {
    this.app = express();
    this.httpServer = http.createServer(this.app);

    this.initMiddlewares();
    this.initRoutes();
    this.initErrorHandlers();
  }

  private initMiddlewares() {
    this.app.set('trust proxy', 1);
    this.app.use(RequestIdMiddleware);
    if (!env.isProduction) mountApiDocs(this.app); // before helmet: its CSP would block Swagger UI
    this.app.use(helmet());
    this.app.use(cors({ origin: env.corsOrigins === '*' ? '*' : env.corsOrigins.split(',') }));
    this.app.use(compression());
    this.app.use(express.json({ limit: '1mb' }));
    this.app.use(express.urlencoded({ extended: true }));
    this.app.use(RequestLoggerMiddleware);
    this.app.use(RateLimiterMiddleware);
    initializeBullBoard(this.app);
    initFirebase();
  }

  private initRoutes() {
    for (const controller of this.controllers) {
      this.app.use(env.apiPrefix, controller.router);
    }
    for (const { path, router } of standaloneRouters) {
      this.app.use(`${env.apiPrefix}${path}`, router);
    }
  }

  private initErrorHandlers() {
    this.app.use(NotFoundMiddleware);
    this.app.use(GlobalErrorHandlerMiddleware);
  }

  async initDatabase() {
    await connectDB();
    await runSeeds();
  }

  runServer(): Promise<void> {
    socketIOHandler(this.httpServer);
    registerBookingSocketEvents();
    registerBookingNotifications();
    registerPaymentRefunds();
    initQueues();

    return new Promise((resolve) => {
      this.httpServer.listen(env.port, () => {
        logger.info(`Server listening on :${env.port}${env.apiPrefix} (${env.nodeEnv})`);
        void sendTopicMessage('server_status', { type: 'SERVER_BACK' });
        resolve();
      });
    });
  }

  /** Closes all Socket.IO clients and the underlying HTTP server. */
  close(): Promise<void> {
    return new Promise((resolve) => getIO().close(() => resolve()));
  }
}
