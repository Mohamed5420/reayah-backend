import { Service } from 'typedi';
import { Types } from 'mongoose';
import type ar from '../../locales/ar.json';
import { NotificationModel } from '../../database/models/notification/notification.model';
import { UserModel } from '../../database/models/user/user.model';
import { UserStatus } from '../../interfaces/enums';
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  NOTIFICATION_SETTING_FOR,
  type INotification,
  type INotificationSettings,
  type NotificationType,
} from '../../interfaces/INotification';
import { enqueueNotification } from '../../queues/producers/notification.producer';
import { emitNotificationToUser } from '../../emit/notification.emit';
import { t, type Language, type TranslationKey } from '../../utils/i18n';
import { logger } from '../../utils/logger/winston';
import type { Pagination } from '../../utils/response/pagination';

/** A template under `notifications` in the locale files: `{ title, body }`. */
export type NotificationTemplate = keyof typeof ar.notifications;

export type NotifyInput = {
  type: NotificationType;
  template: NotificationTemplate;
  /** Placeholder values; a function when they depend on the recipient's language (dates, names). */
  params?: Record<string, string | number> | ((lang: Language) => Record<string, string | number>);
  /** Deep-link ids (strings). `type` and `notification_id` are added automatically. */
  data?: Record<string, string>;
};

/**
 * The one way to notify someone (spec §8): an in-app notification in the recipient's language, a live
 * socket event, and a push via the queue — unless they turned that category off, which silences only
 * the push. Delivery problems are logged, never thrown at the caller: the action already happened.
 */
@Service()
export class NotificationService {
  async notify(userIds: Array<string | Types.ObjectId>, input: NotifyInput) {
    const ids = [...new Set(userIds.map(String))];
    if (!ids.length) return [];
    // Suspended users are still told (e.g. why they were suspended); deleted accounts aren't.
    const users = await UserModel.find({ _id: { $in: ids }, status: { $ne: UserStatus.DELETED } })
      .select('language notificationSettings')
      .lean();

    const created: INotification[] = [];
    for (const user of users) {
      const lang = user.language;
      const params = typeof input.params === 'function' ? input.params(lang) : input.params;
      const title = t(`notifications.${input.template}.title` as TranslationKey, params, lang);
      const body = t(`notifications.${input.template}.body` as TranslationKey, params, lang);
      const notification = await NotificationModel.create({
        userId: user._id,
        type: input.type,
        title,
        body,
        data: input.data ?? {},
      });
      created.push(notification.toObject({ flattenMaps: true }) as unknown as INotification);
      const data = { ...(input.data ?? {}), type: input.type, notification_id: String(notification._id) };

      emitNotificationToUser(String(user._id), {
        id: String(notification._id),
        type: input.type,
        title,
        body,
        data,
      });

      const setting = NOTIFICATION_SETTING_FOR[input.type];
      const settings = { ...DEFAULT_NOTIFICATION_SETTINGS, ...user.notificationSettings };
      if (setting && !settings[setting]) continue;
      await enqueueNotification({ userId: String(user._id), title, body, data }).catch((err: unknown) =>
        logger.error(`Failed to queue push ${input.type} for ${String(user._id)}`, err),
      );
    }
    return created;
  }

  async list(userId: string, pagination: Pagination) {
    const [data, total] = await Promise.all([
      NotificationModel.find({ userId })
        .sort({ createdAt: -1 })
        .skip(pagination.skip)
        .limit(pagination.perPage)
        .lean({ flattenMaps: true }),
      NotificationModel.countDocuments({ userId }),
    ]);
    return { data: data as unknown as INotification[], total };
  }

  unreadCount(userId: string) {
    return NotificationModel.countDocuments({ userId, readAt: null });
  }

  /** Marks the given notifications (or all) as read; only the caller's own. */
  async markRead(userId: string, target: { ids: string[] } | { all: true }) {
    const filter =
      'all' in target
        ? { userId, readAt: null }
        : { userId, readAt: null, _id: { $in: target.ids.filter((id) => Types.ObjectId.isValid(id)) } };
    const result = await NotificationModel.updateMany(filter, { readAt: new Date() });
    return result.modifiedCount;
  }

  async getSettings(userId: string): Promise<INotificationSettings> {
    const user = await UserModel.findById(userId).select('notificationSettings').lean();
    return { ...DEFAULT_NOTIFICATION_SETTINGS, ...user?.notificationSettings };
  }

  async updateSettings(userId: string, settings: Partial<INotificationSettings>) {
    const set = Object.fromEntries(
      Object.entries(settings).map(([k, v]) => [`notificationSettings.${k}`, v]),
    );
    await UserModel.updateOne({ _id: userId }, { $set: set });
    return this.getSettings(userId);
  }
}
