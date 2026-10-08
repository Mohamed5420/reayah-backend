import type { Types } from 'mongoose';

/** Who wrote a message. Organizations' staff chat as `provider` (Phase 3). */
export enum ChatRole {
  PATIENT = 'patient',
  PROVIDER = 'provider',
}

/**
 * Spec §4.9 `conversations`: one per booking AND provider. When an admin reassigns the booking, the
 * conversation with the previous provider is closed (read-only for the patient, hidden from both
 * providers, kept for admins) and the new provider starts a fresh one.
 */
export interface IConversation {
  _id: Types.ObjectId;
  bookingId: Types.ObjectId;
  patientUserId: Types.ObjectId;
  /** The provider on this side of the conversation (fixed for its lifetime). */
  providerProfileId: Types.ObjectId;
  lastMessage: {
    /** Encrypted; preview for the conversation list. */
    body: string | null;
    senderRole: ChatRole;
    hasAttachment: boolean;
    at: Date;
  } | null;
  /** Set when the booking moved to another provider; no more messages after that. */
  closedAt: Date | null;
  closedReason: 'reassigned' | null;
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
