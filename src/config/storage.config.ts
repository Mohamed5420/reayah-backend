import { S3Client } from '@aws-sdk/client-s3';
import { env } from './env.config';

let client: S3Client | undefined;

export const isStorageConfigured = () => Boolean(env.storage.bucket);

/** Works with AWS S3 and S3-compatible stores (MinIO, Cloudflare R2, ...) via `S3_ENDPOINT`. */
export const getS3 = (): S3Client => {
  client ??= new S3Client({
    region: env.storage.region,
    endpoint: env.storage.endpoint,
    forcePathStyle: env.storage.forcePathStyle,
    credentials: env.storage.accessKeyId
      ? { accessKeyId: env.storage.accessKeyId, secretAccessKey: env.storage.secretAccessKey }
      : undefined,
  });
  return client;
};
