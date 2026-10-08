import { ChatRole } from '../../../interfaces/IChat';
import { BookingStatus } from '../../../interfaces/IBooking';
import { objectId, paginationQuery, z } from '../zod';

const message = z
  .object({
    id: objectId,
    conversation_id: objectId,
    booking_id: objectId,
    sender_id: objectId,
    sender_role: z.enum(ChatRole),
    body: z.string().nullable(),
    attachment: z.object({ file_url: z.string(), mime: z.string() }).nullable(),
    /** When the other party read it. */
    read_at: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi('ChatMessage');

/** Request and response schemas for chat (spec §7.12). */
export const ChatSchemas = {
  idParams: z.object({ id: objectId }),
  message,
  messagesQuery: z.object({
    /** A message id from the previous page: returns older messages. */
    before: objectId.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
    /** Patients: read an earlier, closed conversation of this booking (from GET /conversations). */
    conversation_id: objectId.optional(),
  }),
  messagesMeta: z.object({
    next_before: objectId.nullable(),
    can_send: z.boolean(),
    /** null until the first message. */
    conversation_id: objectId.nullable(),
  }),
  sendBody: z
    .strictObject({
      body: z.string().trim().max(2000).nullable().optional(),
      /** From POST /uploads with purpose `chat`. */
      attachment_key: z.string().trim().min(1).max(300).nullable().optional(),
    })
    .openapi('SendMessage'),
  readResult: z.object({ read: z.number() }),
  conversationsQuery: paginationQuery,
  conversation: z
    .object({
      id: objectId,
      booking: z.object({
        id: objectId,
        reference_code: z.string(),
        status: z.enum(BookingStatus),
        service_name: z.string(),
        scheduled_start: z.string(),
      }),
      /** The other participant. */
      with: z.object({ id: objectId, name: z.string(), avatar_url: z.string().nullable() }).nullable(),
      last_message: z
        .object({
          body: z.string().nullable(),
          sender_role: z.enum(ChatRole),
          has_attachment: z.boolean(),
          at: z.string(),
        })
        .nullable(),
      unread_count: z.number(),
      /** Closed after the booking was reassigned to another provider: read-only. */
      closed: z.boolean(),
      can_send: z.boolean(),
    })
    .openapi('Conversation'),
};

/** GET /admin/bookings/{id}/conversations. */
export const adminConversation = z
  .object({
    id: objectId,
    provider_profile_id: objectId,
    closed_at: z.string().nullable(),
    closed_reason: z.enum(['reassigned']).nullable(),
    messages: z.array(ChatSchemas.message),
  })
  .openapi('AdminConversation');
