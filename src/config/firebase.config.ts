import fs from 'node:fs';
import path from 'node:path';
import { cert, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { env } from './env.config';
import { logger } from '../utils/logger/winston';

let initialized = false;

/**
 * Credentials come from the environment only — never from a file committed in the repo: either
 * FIREBASE_SERVICE_ACCOUNT_BASE64 (the service-account JSON, base64) or FIREBASE_SERVICE_ACCOUNT_PATH
 * (a file outside git, e.g. secrets/). If neither is set, Firebase is skipped and pushes become no-ops.
 */
const readServiceAccount = (): object | null => {
  if (env.firebaseServiceAccountBase64) {
    try {
      return JSON.parse(Buffer.from(env.firebaseServiceAccountBase64, 'base64').toString('utf8'));
    } catch {
      logger.warn('FIREBASE_SERVICE_ACCOUNT_BASE64 is not base64-encoded JSON — Firebase disabled');
      return null;
    }
  }
  if (!env.firebaseServiceAccountPath) {
    logger.warn('No Firebase credentials (FIREBASE_SERVICE_ACCOUNT_BASE64 / _PATH) — Firebase disabled');
    return null;
  }
  const filePath = path.resolve(env.firebaseServiceAccountPath);
  if (!fs.existsSync(filePath)) {
    logger.warn(`Firebase service account not found at ${filePath} — Firebase disabled`);
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
};

export const initFirebase = (): boolean => {
  if (initialized) return true;
  const serviceAccount = readServiceAccount();
  if (!serviceAccount) return false;
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
