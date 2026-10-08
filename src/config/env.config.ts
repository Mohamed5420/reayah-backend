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
  /** staging or production: JSON logs to stdout, no stack traces in responses. Staging still prints OTPs and serves /docs. */
  isDeployed: ['staging', 'production'].includes(optional('NODE_ENV')),
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

  /** Referral share links are `<this><CODE>` (GET /me/referral). */
  referralLinkBase: optional('REFERRAL_LINK_BASE', 'https://reaya.app/r/'),

  /**
   * Card / wallet payments (M2.3). `PAYMENT_GATEWAY` picks the provider for new payments; the `fake`
   * one (development, tests, staging before real keys) is refused in production.
   */
  payments: {
    gateway: optional('PAYMENT_GATEWAY', 'fake'),
    /** Public base URL of this API — the gateway calls `<this>/api/v1/webhooks/payments/<gateway>`. */
    publicApiUrl: optional('PUBLIC_API_URL', 'http://localhost:3000'),
    /** Where the app wants the customer back after checkout (`?payment_id=` is appended). */
    appReturnUrl: optional('APP_PAYMENT_RETURN_URL', 'reaya://payment-result'),
    paymob: {
      apiUrl: optional('PAYMOB_API_URL', 'https://accept.paymob.com'),
      checkoutUrl: optional('PAYMOB_CHECKOUT_URL', 'https://eg.checkout.paymob.com/'),
      secretKey: optional('PAYMOB_SECRET_KEY'),
      publicKey: optional('PAYMOB_PUBLIC_KEY'),
      hmacSecret: optional('PAYMOB_HMAC_SECRET'),
      cardIntegrationId: Number(optional('PAYMOB_CARD_INTEGRATION_ID', '0')),
      walletIntegrationId: Number(optional('PAYMOB_WALLET_INTEGRATION_ID', '0')),
    },
  },

  /** Per-IP request limits (Redis-backed, so shared by all instances). */
  rateLimit: {
    perMinute: Number(optional('RATE_LIMIT_PER_MINUTE', '300')),
    authPerMinute: Number(optional('RATE_LIMIT_AUTH_PER_MINUTE', '30')),
  },

  /** Error tracking; disabled when empty. */
  sentryDsn: optional('SENTRY_DSN'),

  bullBoard: {
    user: optional('BULL_BOARD_USER', 'admin'),
    password: optional('BULL_BOARD_PASSWORD'),
  },
} as const;
