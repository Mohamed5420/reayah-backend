import type { messaging } from 'firebase-admin';
import { DeviceModel } from '../../database/models/auth/device.model';
import { logger } from '../../utils/logger/winston';

export type PushMessage = { userId: string; title: string; body: string; data: Record<string, string> };

/** The slice of Firebase Messaging we use — injectable so it can be faked in tests. */
export type PushClient = Pick<messaging.Messaging, 'sendEachForMulticast'>;

/** FCM error codes meaning the token will never work again (app uninstalled, token rotated). */
const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

/**
 * Sends one push to all of a user's devices (spec §7.13) and forgets tokens FCM reports as dead.
 * `data` carries `type` + ids for deep linking. Throws on transient FCM failures so the queue retries.
 */
export const sendPushToUser = async (client: PushClient, message: PushMessage) => {
  const devices = await DeviceModel.find({ userId: message.userId }).select('fcmToken').lean();
  if (!devices.length) return { sent: 0, removed: 0 };

  const tokens = devices.map((d) => d.fcmToken);
  const result = await client.sendEachForMulticast({
    tokens,
    notification: { title: message.title, body: message.body },
    data: message.data,
    android: { priority: 'high' },
    apns: { payload: { aps: { sound: 'default' } } },
  });

  const dead = result.responses.flatMap((r, i) =>
    !r.success && DEAD_TOKEN_CODES.has(r.error?.code ?? '') ? [tokens[i]] : [],
  );
  if (dead.length) await DeviceModel.deleteMany({ fcmToken: { $in: dead } });

  const transient = result.responses.filter((r) => !r.success && !DEAD_TOKEN_CODES.has(r.error?.code ?? ''));
  // Retry (via the queue) only if nothing got through; partial delivery isn't worth duplicating.
  if (transient.length && result.successCount === 0) {
    throw new Error(`FCM failed for user ${message.userId}: ${transient[0].error?.code ?? 'unknown'}`);
  }
  if (transient.length) {
    logger.warn(`FCM: ${transient.length} transient failure(s) for user ${message.userId}`);
  }
  return { sent: result.successCount, removed: dead.length };
};
