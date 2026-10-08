import type { Types } from 'mongoose';

/** Spec §7.13 notification `type` — also the deep-link key in the push `data`. */
export enum NotificationType {
  BOOKING_REQUEST = 'booking_request',
  BOOKING_OFFER = 'booking_offer',
  ASSIGNMENT_DEADLINE_WARNING = 'assignment_deadline_warning',
  BOOKING_STATUS = 'booking_status',
  BOOKING_REMINDER = 'booking_reminder',
  CHAT_MESSAGE = 'chat_message',
  VISIT_REPORT = 'visit_report',
  REVIEW_REQUEST = 'review_request',
  VERIFICATION_RESULT = 'verification_result',
  PAYOUT = 'payout',
  PACKAGE_EXPIRY = 'package_expiry',
  PROMO = 'promo',
  /** Not in the spec list: suspensions, warnings, reactivation. */
  ACCOUNT = 'account',
  /** Not in the spec list: dispute outcomes. */
  DISPUTE = 'dispute',
  /** Not in the spec list: admin service announcements (M3.5) — always pushed, no opt-out. */
  ANNOUNCEMENT = 'announcement',
}

/** Spec §7.13 `/me/notification-settings`. Turning one off silences its push; the in-app list keeps everything. */
export interface INotificationSettings {
  reminders: boolean;
  promotions: boolean;
  chat: boolean;
}

export const DEFAULT_NOTIFICATION_SETTINGS: INotificationSettings = {
  reminders: true,
  promotions: true,
  chat: true,
};

/** Which setting (if any) controls a type's push. Everything else is transactional and always pushed. */
export const NOTIFICATION_SETTING_FOR: Partial<Record<NotificationType, keyof INotificationSettings>> = {
  [NotificationType.BOOKING_REMINDER]: 'reminders',
  [NotificationType.PROMO]: 'promotions',
  [NotificationType.CHAT_MESSAGE]: 'chat',
};

/** Spec §4.9 `notifications`: the in-app inbox. Text is stored in the recipient's language. */
export interface INotification {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  type: NotificationType;
  title: string;
  body: string;
  /** Deep-link ids, all strings (FCM `data` only carries strings). */
  data: Record<string, string>;
  readAt: Date | null;
  /** Set when a message must reach each user at most once (e.g. `broadcast:<id>`); unique per user. */
  dedupeKey?: string | null;
  createdAt: Date;
}
