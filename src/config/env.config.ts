import dotenv from 'dotenv';

dotenv.config();

const required = (key: string): string => {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
};

const optional = (key: string, fallback = ''): string => process.env[key] ?? fallback;

export const env = {
  nodeEnv: optional('NODE_ENV', 'development'),
  isProduction: optional('NODE_ENV') === 'production',
  port: Number(optional('PORT', '3000')),
  apiPrefix: optional('API_PREFIX', '/api/v1'),
  corsOrigins: optional('CORS_ORIGINS', '*'),

  mongoUri: required('MONGO_URI'),

  redis: {
    host: optional('REDIS_HOST', '127.0.0.1'),
    port: Number(optional('REDIS_PORT', '6379')),
    password: optional('REDIS_PASSWORD') || undefined,
  },

  jwt: {
    /** Signs access and registration tokens; also keys the OTP code hashes. */
    secret: required('JWT_SECRET'),
    /** Access token lifetime (spec: `expires_in: 3600`). */
    accessTokenTtlSeconds: Number(optional('ACCESS_TOKEN_TTL_SECONDS', '3600')),
    /** Refresh token (= session) lifetime; each refresh issues a new one with a fresh lifetime. */
    refreshTokenTtlDays: Number(optional('REFRESH_TOKEN_TTL_DAYS', '30')),
  },

  /** `log` prints OTP messages instead of sending them — refused in production. Real provider TBD (spec §12.1). */
  smsDriver: optional('SMS_DRIVER', 'log'),

  /** base64-encoded 32-byte key for AES-256-GCM field encryption (medical data, IDs, license numbers). */
  fieldEncryptionKey: required('FIELD_ENCRYPTION_KEY'),

  /** S3-compatible private bucket. Storage is disabled (calls fail with 503) while `S3_BUCKET` is empty. */
  storage: {
    bucket: optional('S3_BUCKET'),
    region: optional('S3_REGION', 'us-east-1'),
    endpoint: optional('S3_ENDPOINT') || undefined,
    accessKeyId: optional('S3_ACCESS_KEY_ID'),
    secretAccessKey: optional('S3_SECRET_ACCESS_KEY'),
    forcePathStyle: optional('S3_FORCE_PATH_STYLE', 'false') === 'true',
  },

  firebaseServiceAccountPath: optional('FIREBASE_SERVICE_ACCOUNT_PATH'),

  /** Error tracking; disabled when empty. */
  sentryDsn: optional('SENTRY_DSN'),

  bullBoard: {
    user: optional('BULL_BOARD_USER', 'admin'),
    password: optional('BULL_BOARD_PASSWORD'),
  },
} as const;
