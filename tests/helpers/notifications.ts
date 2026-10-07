import { vi } from 'vitest';
import { enqueueNotification } from '../../src/queues/producers/notification.producer';
import type { SendNotificationJob } from '../../src/queues/jobs/notification.job';

/** Pushes the app queued (the producer is mocked in tests/setup/env.ts). */
export const queuedPushes = (): SendNotificationJob[] =>
  vi.mocked(enqueueNotification).mock.calls.map(([job]) => job as SendNotificationJob);

export const clearQueuedPushes = () => vi.mocked(enqueueNotification).mockClear();

/** Event listeners run asynchronously after commit — poll until `check` passes (or time out). */
export const eventually = async <T>(check: () => Promise<T> | T, timeoutMs = 3000): Promise<T> => {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      return await check();
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError;
};
