import { Router, type NextFunction, type Request, type Response } from 'express';
import { Container } from 'typedi';
import type IBaseController from '../interfaces/base-controller.interface';
import { CheckAppStatusMiddleware } from '../../middlewares/app';
import { Auth } from '../../middlewares/auth';
import { ChatSchemas } from '../../validations/chat/chat.validation';
import { z } from '../../validations/zod';
import { presentConversation, presentMessage } from '../../presenters/chat.presenter';
import { defineRoute, type DefinedRoute } from '../../../docs/openapi';
import { ChatService } from '../../../services/chat/chat.service';
import { StorageService } from '../../../services/storage';
import { UserRole } from '../../../interfaces/enums';
import { HttpResponse } from '../../../utils/response/http-response';
import { parsePagination } from '../../../utils/response/pagination';
import { resolveLanguage } from '../../../utils/i18n';

const tags = ['Chat'];
const auth = true;
const params = ChatSchemas.idParams;

const r = {
  conversations: defineRoute({
    method: 'get',
    path: '/conversations',
    summary: 'My chats, latest message first, with unread counts',
    tags,
    auth,
    request: { query: ChatSchemas.conversationsQuery },
    response: { schema: ChatSchemas.conversation, paginated: true },
  }),
  messages: defineRoute({
    method: 'get',
    path: '/bookings/:id/messages',
    summary: 'Messages, newest first. Pass meta.next_before as `before` for older ones.',
    tags,
    auth,
    request: { params, query: ChatSchemas.messagesQuery },
    response: { schema: z.array(ChatSchemas.message), meta: ChatSchemas.messagesMeta },
  }),
  send: defineRoute({
    method: 'post',
    path: '/bookings/:id/messages',
    summary:
      'Send a message (text and/or an attachment from POST /uploads, purpose chat). Open from accepted until 24 h after completed; 30 messages/minute.',
    tags,
    auth,
    request: { params, body: ChatSchemas.sendBody },
    response: { status: 201, schema: ChatSchemas.message },
  }),
  read: defineRoute({
    method: 'post',
    path: '/bookings/:id/messages/read',
    summary: "Mark the other party's messages as read (they get message.read)",
    tags,
    auth,
    request: { params },
    response: { schema: ChatSchemas.readResult },
  }),
};

/**
 * Patient ↔ provider chat per booking (spec §7.12). Live updates: `message.new` / `message.read` on the
 * `booking:<id>` socket room (and each participant's own room).
 */
export default class ChatController implements IBaseController {
  path = '/';
  router = Router();

  private chat = Container.get(ChatService);
  private storage = Container.get(StorageService);

  constructor() {
    this.initializeRoutes();
  }

  initializeRoutes() {
    this.mount(r.conversations, async (req, res) => {
      const pagination = parsePagination(req.query);
      const { data, total } = await this.chat.conversations(req.user!.id, pagination);
      const lang = resolveLanguage(req);
      const items = await Promise.all(
        data.map(async (row) =>
          presentConversation(
            row,
            row.other?.avatarKey ? await this.storage.signedUrl(row.other.avatarKey) : null,
            lang,
          ),
        ),
      );
      return HttpResponse.paginated(res, items, pagination, total);
    });
    this.mount(r.messages, async (req, res) => {
      const q = req.query as unknown as z.infer<typeof ChatSchemas.messagesQuery>;
      const page = await this.chat.messages(req.user!.id, req.params.id, {
        before: q.before,
        limit: q.limit,
        conversationId: q.conversation_id,
      });
      return HttpResponse.ok(res, page.data.map(presentMessage), {
        next_before: page.nextBefore,
        can_send: page.canSend,
        conversation_id: page.conversationId,
      });
    });
    this.mount(r.send, async (req, res) => {
      const body = req.body as z.infer<typeof ChatSchemas.sendBody>;
      const message = await this.chat.send(req.user!.id, req.params.id, {
        body: body.body,
        attachmentKey: body.attachment_key,
      });
      return HttpResponse.created(res, presentMessage(message));
    });
    this.mount(r.read, async (req, res) =>
      HttpResponse.ok(res, await this.chat.markRead(req.user!.id, req.params.id)),
    );
  }

  private mount(route: DefinedRoute, handler: (req: Request, res: Response) => Promise<unknown>) {
    this.router[route.method](
      route.path,
      CheckAppStatusMiddleware,
      route.validate,
      ...Auth(UserRole.PATIENT, UserRole.PROVIDER, UserRole.PROVIDER_STAFF),
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          await handler(req, res);
        } catch (err) {
          next(err);
        }
      },
    );
  }
}
