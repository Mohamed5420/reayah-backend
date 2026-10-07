import mongoose, { type ClientSession } from 'mongoose';

/**
 * Runs `work` in a MongoDB transaction (replica set required) and returns its result. Pass the session
 * to every query inside: `Model.updateOne(filter, update, { session })`, `doc.save({ session })`.
 * Throwing inside aborts everything; transient errors are retried by the driver.
 */
export const withTransaction = async <T>(work: (session: ClientSession) => Promise<T>): Promise<T> => {
  const session = await mongoose.startSession();
  try {
    let result!: T;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
};
