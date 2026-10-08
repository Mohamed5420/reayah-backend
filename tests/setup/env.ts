import 'reflect-metadata';
import { vi } from 'vitest';

// Runs before every test file, ahead of any app import: env.config reads these at load time.
process.env.NODE_ENV = 'test';
process.env.MONGO_URI = 'mongodb://unused-see-tests-helpers-db'; // tests connect via useTestDatabase()
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.FIELD_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.S3_BUCKET = 'reaya-test';
process.env.S3_ENDPOINT = 'http://127.0.0.1:9000';
process.env.S3_ACCESS_KEY_ID = 'test';
process.env.S3_SECRET_ACCESS_KEY = 'test';
process.env.S3_FORCE_PATH_STYLE = 'true';
process.env.TEST_PHONE_NUMBERS = '+201500000001,+201500000002,+201500000003,+201500000004';
process.env.TEST_OTP_CODE = '2468';
process.env.BULL_BOARD_PASSWORD = ''; // keep Bull Board (and its BullMQ queues) out of test apps

// Pushes are queued to BullMQ in the app; tests record them instead (assert with `queuedPushes()`).
vi.mock('../../src/queues/producers/notification.producer', () => ({
  enqueueNotification: vi.fn(async () => undefined),
}));

// In-memory Redis for the app's own client (cache, idempotency). Not used by BullMQ in tests.
vi.mock('ioredis', async () => {
  const { default: RedisMock } = await import('ioredis-mock');
  return { default: RedisMock, Redis: RedisMock };
});
