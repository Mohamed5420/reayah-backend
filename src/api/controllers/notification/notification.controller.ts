import { Router, type NextFunction, type Request, type Response } from 'express';
import { Container } from 'typedi';
import type IBaseController from '../interfaces/base-controller.interface';
import { CheckAppStatusMiddleware } from '../../middlewares/app';
import { Auth } from '../../middlewares/auth';
import { objectId, paginationQuery, z } from '../../validations/zod';
import { defineRoute } from '../../../docs/openapi';
import { NotificationService } from '../../../services/notification';
import { NotificationType, type INotification } from '../../../interfaces/INotification';
import { HttpResponse } from '../../../utils/response/http-response';
import { parsePagination } from '../../../utils/response/pagination';

const tags = ['Notifications'];
const auth = true;

const notification = z
  .object({
    id: objectId,
    type: z.enum(NotificationType),
    title: z.string(),
    body: z.string(),
    data: z.record(z.string(), z.string()),
    read_at: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi('Notification');

const settings = z
  .object({ reminders: z.boolean(), promotions: z.boolean(), chat: z.boolean() })
  .openapi('NotificationSettings');

const r = {
  list: defineRoute({
    method: 'get',
    path: '/notifications',
    summary: 'My notifications, newest first (kept 180 days)',
    tags,
    auth,
    request: { query: paginationQuery },
    response: { schema: notification, paginated: true },
  }),
  read: defineRoute({
    method: 'post',
    path: '/notifications/read',
    summary: 'Mark notifications read: `{ "ids": [...] }` or `{ "all": true }`',
    tags,
    auth,
    request: {
      body: z.union([
        z.object({ ids: z.array(objectId).min(1).max(100) }),
        z.object({ all: z.literal(true) }),
      ]),
    },
    response: { schema: z.object({ updated: z.number(), unread: z.number() }) },
  }),
  getSettings: defineRoute({
    method: 'get',
    path: '/me/notification-settings',
    summary: 'Notification preferences (turning one off silences its push; the in-app list keeps everything)',
    tags,
    auth,
    response: { schema: settings },
  }),
  putSettings: defineRoute({
    method: 'put',
    path: '/me/notification-settings',
    summary: 'Update notification preferences',
    tags,
    auth,
    request: { body: settings.partial() },
    response: { schema: settings },
  }),
};

const present = (n: INotification) => ({
  id: String(n._id),
  type: n.type,
  title: n.title,
  body: n.body,
  data: n.data ?? {},
  read_at: n.readAt ? n.readAt.toISOString() : null,
  created_at: n.createdAt.toISOString(),
});

/** In-app notifications and preferences (spec §7.13). Push payloads carry the same `data` for deep links. */
export default class NotificationController implements IBaseController {
  path = '/notifications';
  router = Router();

  private notifications = Container.get(NotificationService);

  constructor() {
    this.initializeRoutes();
  }

  initializeRoutes() {
    const chain = (route: { validate: typeof r.list.validate }) => [
      CheckAppStatusMiddleware,
      route.validate,
      ...Auth(),
    ];

    this.router.get(
      r.list.path,
      ...chain(r.list),
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          const pagination = parsePagination(req.query);
          const { data, total } = await this.notifications.list(req.user!.id, pagination);
          return HttpResponse.paginated(res, data.map(present), pagination, total);
        } catch (err) {
          next(err);
        }
      },
    );

    this.router.post(
      r.read.path,
      ...chain(r.read),
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          const updated = await this.notifications.markRead(req.user!.id, req.body);
          return HttpResponse.ok(res, {
            updated,
            unread: await this.notifications.unreadCount(req.user!.id),
          });
        } catch (err) {
          next(err);
        }
      },
    );

    this.router.get(
      r.getSettings.path,
      ...chain(r.getSettings),
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          return HttpResponse.ok(res, await this.notifications.getSettings(req.user!.id));
        } catch (err) {
          next(err);
        }
      },
    );

    this.router.put(
      r.putSettings.path,
      ...chain(r.putSettings),
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          return HttpResponse.ok(res, await this.notifications.updateSettings(req.user!.id, req.body));
        } catch (err) {
          next(err);
        }
      },
    );
  }
}
