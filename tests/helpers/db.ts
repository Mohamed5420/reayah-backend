import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { afterAll, afterEach, beforeAll, inject } from 'vitest';
import { getRedis } from '../../src/config/redis.config';

/**
 * Connects the file to its own database on the shared in-memory replica set,
 * wipes all collections and Redis after each test, and disconnects at the end.
 */
export const useTestDatabase = () => {
  beforeAll(async () => {
    await mongoose.connect(inject('mongoUri'), { dbName: `test_${randomUUID().slice(0, 8)}` });
    // Build indexes (e.g. unique) before tests rely on them.
    await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
  });

  afterEach(async () => {
    const collections = await mongoose.connection.db!.collections();
    await Promise.all(collections.map((collection) => collection.deleteMany({})));
    await getRedis().flushall();
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
};
