import fs from 'node:fs';
import path from 'node:path';
import { cert, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { env } from './env.config';
import { logger } from '../utils/logger/winston';

let initialized = false;

/**
 * Credentials are read from FIREBASE_SERVICE_ACCOUNT_PATH — never from a file committed in the repo.
 * If the path is unset, Firebase is skipped and push notifications become no-ops.
 */
export const initFirebase = (): boolean => {
  if (initialized) return true;
  if (!env.firebaseServiceAccountPath) {
    logger.warn('FIREBASE_SERVICE_ACCOUNT_PATH not set — Firebase disabled');
    return false;
  }

  const filePath = path.resolve(env.firebaseServiceAccountPath);
  if (!fs.existsSync(filePath)) {
    logger.warn(`Firebase service account not found at ${filePath} — Firebase disabled`);
    return false;
  }

  const serviceAccount = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  initializeApp({ credential: cert(serviceAccount) });
  initialized = true;
  logger.info('Firebase initialized');
  return true;
};

export const isFirebaseReady = () => initialized;

export const sendTopicMessage = async (topic: string, data: Record<string, string>) => {
  if (!initialized) return;
  try {
    await getMessaging().send({ topic, data });
  } catch (err) {
    logger.error(`FCM send to topic "${topic}" failed`, err);
  }
};
