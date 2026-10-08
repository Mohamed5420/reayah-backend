import type { MessageView } from '../../services/chat/chat.service';
import type { IBooking } from '../../interfaces/IBooking';
import type { IConversation } from '../../interfaces/IChat';
import type { Language } from '../../utils/i18n';

/** Maps chat data to the API shapes in chat.validation.ts. */

export const presentMessage = (m: MessageView) => ({
  id: String(m._id),
  booking_id: String(m.bookingId),
  sender_id: String(m.senderId),
  sender_role: m.senderRole,
  body: m.body,
  attachment: m.attachment ? { file_url: m.attachment.fileUrl, mime: m.attachment.mime } : null,
  read_at: m.readAt ? m.readAt.toISOString() : null,
  created_at: m.createdAt.toISOString(),
});

export const presentConversation = (
  row: {
    conversation: IConversation;
    booking: IBooking;
    preview: string | null;
    unread: number;
    other: { id: string; name: string } | null;
    canSend: boolean;
  },
  avatarUrl: string | null,
  lang: Language,
) => ({
  id: String(row.conversation._id),
  booking: {
    id: String(row.booking._id),
    reference_code: row.booking.referenceCode,
    status: row.booking.status,
    service_name:
      lang === 'en' && row.booking.service.nameEn ? row.booking.service.nameEn : row.booking.service.nameAr,
    scheduled_start: row.booking.scheduledStart.toISOString(),
  },
  with: row.other ? { id: row.other.id, name: row.other.name, avatar_url: avatarUrl } : null,
  last_message: row.conversation.lastMessage
    ? {
        body: row.preview,
        sender_role: row.conversation.lastMessage.senderRole,
        has_attachment: row.conversation.lastMessage.hasAttachment,
        at: row.conversation.lastMessage.at.toISOString(),
      }
    : null,
  unread_count: row.unread,
  can_send: row.canSend,
});
