import { Schema, model } from 'mongoose';
import { NotificationType, type INotification } from '../../../interfaces/INotification';

const notificationSchema = new Schema<INotification>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: Object.values(NotificationType), required: true },
    title: { type: String, required: true },
    body: { type: String, required: true },
    data: { type: Map, of: String, default: {} },
    readAt: { type: Date, default: null },
    dedupeKey: { type: String, default: undefined },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

// Inbox (newest first) and the unread badge.
notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, readAt: 1 });
// At most once per user for keyed messages (a broadcast resumed after a crash skips who already has it).
notificationSchema.index(
  { userId: 1, dedupeKey: 1 },
  { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } },
);
// The inbox keeps 180 days.
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 3600 });

export const NotificationModel = model<INotification>('Notification', notificationSchema);
