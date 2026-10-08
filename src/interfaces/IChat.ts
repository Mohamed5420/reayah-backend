import type { Types } from 'mongoose';

/** Who wrote a message. Organizations' staff chat as `provider` (Phase 3). */
export enum ChatRole {
  PATIENT = 'patient',
  PROVIDER = 'provider',
}

/** Spec §4.9 `conversations`: one per booking. Participants come from the booking (patient + assigned provider). */
export interface IConversation {
  _id: Types.ObjectId;
  bookingId: Types.ObjectId;
  patientUserId: Types.ObjectId;
  /** The provider assigned when the last message was sent (an admin reassign moves the chat with the booking). */
  providerProfileId: Types.ObjectId | null;
  lastMessage: {
    /** Encrypted; preview for the conversation list. */
    body: string | null;
    senderRole: ChatRole;
    hasAttachment: boolean;
    at: Date;
  } | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Spec §4.9 `messages`. The body may describe the patient's condition: encrypted at rest. */
export interface IMessage {
  _id: Types.ObjectId;
  conversationId: Types.ObjectId;
  bookingId: Types.ObjectId;
  senderId: Types.ObjectId;
  senderRole: ChatRole;
  body: string | null;
  attachmentKey: string | null;
  /** When the other party read it. */
  readAt: Date | null;
  createdAt: Date;
}
