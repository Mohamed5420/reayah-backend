import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { SchemaTypeOptions } from 'mongoose';
import { env } from '../../config/env.config';

/**
 * Field-level encryption for sensitive data at rest (spec §9: medical data, national IDs, license numbers).
 * AES-256-GCM with a random IV per value, stored as `enc:v1:<iv>:<tag>:<ciphertext>` (base64).
 * The version prefix leaves room for key rotation later.
 */
const PREFIX = 'enc:v1:';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

const key = Buffer.from(env.fieldEncryptionKey, 'base64');
if (key.length !== 32) {
  throw new Error('FIELD_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
}

export const isEncrypted = (value: string) => value.startsWith(PREFIX);

export const encryptField = (plain: string): string => {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
};

/** Throws if the value was tampered with or encrypted with another key. Plain (legacy) values pass through. */
export const decryptField = (value: string): string => {
  if (!isEncrypted(value)) return value;
  const [iv, tag, ciphertext] = value
    .slice(PREFIX.length)
    .split(':')
    .map((part) => Buffer.from(part, 'base64'));
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
};

/**
 * Schema type for an encrypted string field: `licenseNumber: encryptedString<string | null>({ default: null })`
 * or `encryptedString({ required: true })`. Values are encrypted on set and decrypted on get, so the schema
 * needs `toJSON: { getters: true }` and `toObject: { getters: true }`.
 *
 * Limits: `.lean()` results hold ciphertext (call `decryptField` yourself), and the field can't be
 * queried by value or indexed meaningfully, since the same input encrypts differently every time.
 */
export const encryptedString = <T extends string | null = string>(
  options: SchemaTypeOptions<T> = {},
): SchemaTypeOptions<T> => ({
  ...options,
  type: String as SchemaTypeOptions<T>['type'],
  // null/undefined/'' pass through untouched so `required` and defaults behave normally.
  set: (value?: string | null) => (value && !isEncrypted(value) ? encryptField(value) : value) as T,
  get: (value?: string | null) => (value ? decryptField(value) : value) as T,
});
