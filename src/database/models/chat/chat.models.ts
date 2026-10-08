import { Schema, model } from 'mongoose';
import { ChatRole, type IConversation, type IMessage } from '../../../interfaces/IChat';
import { baseSchemaOptions } from '../../schema-options';
import { encryptOnWrite } from '../../../utils/crypto/field-encryption';

/**
 * Chat (spec §4.9, §7.12). No soft delete: a booking's chat is part of its record, like the booking.
 * Message bodies (and the list preview) are encrypted on write and decrypted in the presenter.
 */
const conversationSchema = new Schema<IConversation>(
  {
    bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true },
    patientUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    providerProfileId: { type: Schema.Types.ObjectId, ref: 'ProviderProfile', required: true },
    closedAt: { type: Date, default: null },
    closedReason: { type: String, enum: ['reassigned', null], default: null },
    lastMessage: {
      type: new Schema(
        {
          body: encryptOnWrite({ default: null }),
          senderRole: { type: String, enum: Object.values(ChatRole), required: true },
          hasAttachment: { type: Boolean, default: false },
          at: { type: Date, required: true },
        },
        { _id: false },
      ),
      default: null,
    },
  },
  baseSchemaOptions,
);
// One open conversation per booking and provider; closed ones stay for the record.
conversationSchema.index(
  { bookingId: 1, providerProfileId: 1 },
  { unique: true, partialFilterExpression: { closedAt: { $type: 'null' } } },
);
conversationSchema.index({ patientUserId: 1, 'lastMessage.at': -1 });
conversationSchema.index({ providerProfileId: 1, 'lastMessage.at': -1 });

export const ConversationModel = model<IConversation>('Conversation', conversationSchema);

const messageSchema = new Schema<IMessage>(
  {
    conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true },
    bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true },
    senderId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    senderRole: { type: String, enum: Object.values(ChatRole), required: true },
    body: encryptOnWrite({ default: null }),
    attachmentKey: { type: String, default: null },
    readAt: { type: Date, default: null },
  },
  { ...baseSchemaOptions, timestamps: { createdAt: true, updatedAt: false } },
);
// Newest-first pages per conversation; unread counts per conversation.
messageSchema.index({ conversationId: 1, _id: -1 });
messageSchema.index({ conversationId: 1, senderRole: 1, readAt: 1 });

export const MessageModel = model<IMessage>('Message', messageSchema);
