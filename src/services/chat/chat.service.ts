import { Container, Service } from 'typedi';
import { Types } from 'mongoose';
import { BookingModel } from '../../database/models/booking/booking.model';
import { ConversationModel, MessageModel } from '../../database/models/chat/chat.models';
import { ProviderProfileModel } from '../../database/models/provider/provider-profile.model';
import { UserModel } from '../../database/models/user/user.model';
import type { IBooking } from '../../interfaces/IBooking';
import { chatOpen } from './chat-window';
import { ChatRole, type IConversation, type IMessage } from '../../interfaces/IChat';
import { NotificationType } from '../../interfaces/INotification';
import { emitChatEvent, ChatSocketEvents, isViewingBooking } from '../../emit/chat.emit';
import { decryptNullable, encryptField } from '../../utils/crypto/field-encryption';
import { isOverLimit } from '../../utils/rate-limit';
import type { Pagination } from '../../utils/response/pagination';
import {
  ConflictError,
  NotFoundError,
  TooManyRequestsError,
  ValidationError,
} from '../../utils/types-errors';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { NotificationService } from '../notification/notification.service';
import { StorageService, mimeOfKey } from '../storage/storage.service';

export { chatOpen, CHAT_HOURS_AFTER_COMPLETION } from './chat-window';

/** Messages per user per minute. */
export const CHAT_SENDS_PER_MINUTE = 30;
export const MESSAGES_PAGE_MAX = 100;
/** Admin dispute view: messages per conversation. */
export const ADMIN_MESSAGES_MAX = 1000;

/** A message as the API shows it: decrypted body, signed attachment URL. */
export type MessageView = Omit<IMessage, 'body' | 'attachmentKey'> & {
  body: string | null;
  attachment: { fileUrl: string; mime: string } | null;
};

type Access = { booking: IBooking; role: ChatRole; providerUserId: string | null };

/**
 * Patient ↔ provider chat (spec §4.9, §7.12): one conversation per booking and provider. Only the booking's
 * patient and its currently assigned provider take part; after an admin reassignment the old conversation
 * is closed — read-only for the patient, gone for both providers, kept for admins (disputes).
 * Message bodies are encrypted at rest; pushes say only that a message arrived (never the text).
 */
@Service()
export class ChatService {
  private readonly storage = Container.get(StorageService);
  private readonly notifications = Container.get(NotificationService);
  private readonly audit = Container.get(AuditService);

  async send(
    userId: string,
    bookingId: string,
    input: { body?: string | null; attachmentKey?: string | null },
  ) {
    const { booking, role, providerUserId } = await this.access(userId, bookingId);
    if (!chatOpen(booking) || !booking.providerProfileId) throw new ConflictError('errors.chat_closed');
    const body = input.body?.trim() || null;
    if (!body && !input.attachmentKey) throw new ValidationError({ body: ['validation.required'] });
    if (await isOverLimit(`chat:${userId}`, CHAT_SENDS_PER_MINUTE, 60)) throw new TooManyRequestsError();

    const attachmentKey = input.attachmentKey
      ? await this.storage.promote(input.attachmentKey, {
          ownerId: userId,
          purpose: 'chat',
          destPrefix: `chat/${bookingId}`,
        })
      : null;
    const now = new Date();
    const conversation = await ConversationModel.findOneAndUpdate(
      { bookingId: booking._id, providerProfileId: booking.providerProfileId, closedAt: null },
      {
        $setOnInsert: {
          bookingId: booking._id,
          providerProfileId: booking.providerProfileId,
          patientUserId: booking.patientUserId,
        },
        $set: {
          lastMessage: {
            body: body ? encryptField(body.slice(0, 120)) : null,
            senderRole: role,
            hasAttachment: !!attachmentKey,
            at: now,
          },
        },
      },
      { upsert: true, new: true, lean: true },
    );
    if (!conversation) throw new Error('conversation upsert returned nothing');
    const message = await MessageModel.create({
      conversationId: conversation._id,
      bookingId: booking._id,
      senderId: userId,
      senderRole: role,
      body,
      attachmentKey,
    });
    const view = await this.view(message.toObject());

    const recipientId = role === ChatRole.PATIENT ? providerUserId : String(booking.patientUserId);
    emitChatEvent(bookingId, [String(booking.patientUserId), providerUserId], ChatSocketEvents.NEW, view);
    if (recipientId && !(await isViewingBooking(bookingId, recipientId))) {
      const sender = await UserModel.findById(userId).select('fullName').lean();
      await this.notifications.pushOnly([recipientId], {
        type: NotificationType.CHAT_MESSAGE,
        template: 'chat_message',
        params: (lang) => ({
          sender: sender?.fullName ?? '',
          service: lang === 'en' && booking.service.nameEn ? booking.service.nameEn : booking.service.nameAr,
        }),
        data: { booking_id: bookingId },
      });
    }
    return view;
  }

  /**
   * Newest first, `limit` per page; pass the last id back as `before` for older messages. Defaults to the
   * open conversation with the current provider; a patient may pass `conversationId` to read a closed one.
   */
  async messages(
    userId: string,
    bookingId: string,
    page: { before?: string; limit: number; conversationId?: string },
  ) {
    const { booking, role } = await this.access(userId, bookingId);
    const limit = Math.min(page.limit, MESSAGES_PAGE_MAX);
    let conversation: IConversation | null;
    if (page.conversationId) {
      conversation =
        role === ChatRole.PATIENT && Types.ObjectId.isValid(page.conversationId)
          ? await ConversationModel.findOne({ _id: page.conversationId, bookingId: booking._id }).lean()
          : null;
      if (!conversation) throw new NotFoundError('errors.conversation_not_found');
    } else {
      conversation = await this.openConversation(booking);
    }
    if (!conversation) {
      return { data: [], nextBefore: null, canSend: chatOpen(booking), conversationId: null };
    }
    const rows = await MessageModel.find({
      conversationId: conversation._id,
      ...(page.before ? { _id: { $lt: new Types.ObjectId(page.before) } } : {}),
    })
      .sort({ _id: -1 })
      .limit(limit + 1)
      .lean();
    const hasMore = rows.length > limit;
    const data = await Promise.all(rows.slice(0, limit).map((m) => this.view(m)));
    return {
      data,
      nextBefore: hasMore ? String(data[data.length - 1]._id) : null,
      canSend: !conversation.closedAt && chatOpen(booking),
      conversationId: String(conversation._id),
    };
  }

  /** Marks everything the other party sent as read; tells the sender over the socket. */
  async markRead(userId: string, bookingId: string) {
    const { booking, role, providerUserId } = await this.access(userId, bookingId);
    const conversation = await this.openConversation(booking);
    if (!conversation) return { read: 0 };
    const readAt = new Date();
    const result = await MessageModel.updateMany(
      { conversationId: conversation._id, senderRole: { $ne: role }, readAt: null },
      { readAt },
    );
    if (result.modifiedCount) {
      emitChatEvent(bookingId, [String(booking.patientUserId), providerUserId], ChatSocketEvents.READ, {
        reader_role: role,
        read_at: readAt.toISOString(),
      });
    }
    return { read: result.modifiedCount };
  }

  /** GET /conversations — the caller's chats, latest message first, with unread counts. */
  async conversations(userId: string, pagination: Pagination) {
    const profile = await ProviderProfileModel.findOne({ userId }).select('_id').lean();
    // Providers see only their open conversations; patients also see closed ones (read-only).
    const query = profile
      ? { providerProfileId: profile._id, closedAt: null }
      : { patientUserId: new Types.ObjectId(userId) };
    const myRole = profile ? ChatRole.PROVIDER : ChatRole.PATIENT;
    const [conversations, total] = await Promise.all([
      ConversationModel.find(query)
        .sort({ 'lastMessage.at': -1 })
        .skip(pagination.skip)
        .limit(pagination.perPage)
        .lean(),
      ConversationModel.countDocuments(query),
    ]);
    const ids = conversations.map((c) => c._id);
    const [unread, bookings] = await Promise.all([
      MessageModel.aggregate<{ _id: Types.ObjectId; n: number }>([
        { $match: { conversationId: { $in: ids }, senderRole: { $ne: myRole }, readAt: null } },
        { $group: { _id: '$conversationId', n: { $sum: 1 } } },
      ]),
      BookingModel.find({ _id: { $in: conversations.map((c) => c.bookingId) } }).lean(),
    ]);
    const unreadBy = new Map(unread.map((u) => [String(u._id), u.n]));
    const bookingBy = new Map(bookings.map((b) => [String(b._id), b]));
    const others = await this.otherParties(conversations, myRole);
    return {
      total,
      data: conversations.map((c) => {
        const booking = bookingBy.get(String(c.bookingId))!;
        return {
          conversation: c,
          booking,
          preview: c.lastMessage ? decryptNullable(c.lastMessage.body) : null,
          unread: unreadBy.get(String(c._id)) ?? 0,
          other: others.get(String(c._id)) ?? null,
          canSend: !c.closedAt && chatOpen(booking),
        };
      }),
    };
  }

  /**
   * After an admin reassigns a booking: closes the conversation with the previous provider. The patient
   * keeps it read-only; neither provider can open it; admins still can.
   */
  async closeForReassignment(
    bookingId: Types.ObjectId | string,
    previousProviderProfileId: Types.ObjectId | string,
  ) {
    await ConversationModel.updateMany(
      { bookingId, providerProfileId: previousProviderProfileId, closedAt: null },
      { closedAt: new Date(), closedReason: 'reassigned' },
    );
  }

  /** Every conversation of a booking with its messages, for admins (disputes). Audited: messages may hold health details. */
  async forAdmin(bookingId: string, context: AuditContext) {
    const booking = Types.ObjectId.isValid(bookingId) ? await BookingModel.findById(bookingId).lean() : null;
    if (!booking) throw new NotFoundError('errors.booking_not_found');
    const conversations = await ConversationModel.find({ bookingId: booking._id })
      .sort({ createdAt: 1 })
      .lean();
    const result = await Promise.all(
      conversations.map(async (conversation) => {
        const messages = await MessageModel.find({ conversationId: conversation._id })
          .sort({ _id: 1 })
          .limit(ADMIN_MESSAGES_MAX)
          .lean();
        return { conversation, messages: await Promise.all(messages.map((m) => this.view(m))) };
      }),
    );
    await this.audit.log(context, {
      action: 'chat.read',
      entityType: 'booking',
      entityId: bookingId,
      metadata: { conversations: conversations.length },
    });
    return result;
  }

  private openConversation(booking: IBooking) {
    if (!booking.providerProfileId) return Promise.resolve(null);
    return ConversationModel.findOne({
      bookingId: booking._id,
      providerProfileId: booking.providerProfileId,
      closedAt: null,
    }).lean();
  }

  /** Booking detail flag: can this booking be chatted about right now? */
  canChat(booking: Pick<IBooking, 'status' | 'completedAt'>) {
    return chatOpen(booking);
  }

  private async view(message: IMessage): Promise<MessageView> {
    const { body, attachmentKey, ...rest } = message;
    return {
      ...rest,
      body: decryptNullable(body),
      attachment: attachmentKey
        ? { fileUrl: await this.storage.signedUrl(attachmentKey), mime: mimeOfKey(attachmentKey) }
        : null,
    };
  }

  /** The booking's patient or its current provider; anyone else gets 404 (no existence leak). */
  private async access(userId: string, bookingId: string): Promise<Access> {
    const booking = Types.ObjectId.isValid(bookingId) ? await BookingModel.findById(bookingId).lean() : null;
    if (!booking) throw new NotFoundError('errors.booking_not_found');
    const providerUserId = booking.providerProfileId
      ? String(
          (await ProviderProfileModel.findById(booking.providerProfileId).select('userId').lean())?.userId ??
            '',
        )
      : null;
    if (String(booking.patientUserId) === userId) return { booking, role: ChatRole.PATIENT, providerUserId };
    if (providerUserId && providerUserId === userId)
      return { booking, role: ChatRole.PROVIDER, providerUserId };
    throw new NotFoundError('errors.booking_not_found');
  }

  /** The person on the other side of each conversation: name + avatar key. */
  private async otherParties(conversations: IConversation[], myRole: ChatRole) {
    const userIds = new Map<string, string>();
    if (myRole === ChatRole.PATIENT) {
      const profiles = await ProviderProfileModel.find({
        _id: { $in: conversations.map((c) => c.providerProfileId).filter(Boolean) },
      })
        .select('userId')
        .lean();
      const userByProfile = new Map(profiles.map((p) => [String(p._id), String(p.userId)]));
      for (const c of conversations) {
        const u = c.providerProfileId ? userByProfile.get(String(c.providerProfileId)) : undefined;
        if (u) userIds.set(String(c._id), u);
      }
    } else {
      for (const c of conversations) userIds.set(String(c._id), String(c.patientUserId));
    }
    const users = await UserModel.find({ _id: { $in: [...new Set(userIds.values())] } })
      .select('fullName avatarKey')
      .setOptions({ withDeleted: true })
      .lean();
    const byId = new Map(users.map((u) => [String(u._id), u]));
    return new Map(
      [...userIds.entries()].flatMap(([conversationId, uid]) => {
        const user = byId.get(uid);
        return user
          ? [[conversationId, { id: uid, name: user.fullName, avatarKey: user.avatarKey }] as const]
          : [];
      }),
    );
  }
}
