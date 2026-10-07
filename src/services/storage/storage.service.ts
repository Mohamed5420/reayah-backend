import { randomUUID } from 'node:crypto';
import { Service } from 'typedi';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../../config/env.config';
import { getS3, isStorageConfigured } from '../../config/storage.config';
import { NotFoundError, ServiceUnavailableError } from '../../utils/types-errors';

/** `purpose` of `POST /uploads` (spec §7.4). */
export const UPLOAD_PURPOSES = [
  'provider_document',
  'org_document',
  'medical_document',
  'chat',
  'visit_report',
  'avatar',
  'dispute', // not in spec §7.4's list: dispute attachments (§7.8) need their own purpose
] as const;
export type UploadPurpose = (typeof UPLOAD_PURPOSES)[number];

/** Signed read URLs are valid for 10 minutes (spec §7.4 `file_url`). */
export const SIGNED_URL_TTL_SECONDS = 600;

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'application/pdf': '.pdf',
};

/** Content type of a stored file, from the extension `putTemp`/`put` gave it. */
export const mimeOfKey = (key: string): string =>
  Object.entries(EXTENSIONS).find(([, ext]) => key.endsWith(ext))?.[0] ?? 'application/octet-stream';

/**
 * Private file storage (spec §7.4, §9). Upload flow:
 * 1. `putTemp` stores the file under `tmp/<ownerId>/<purpose>/` and returns its `file_key`.
 * 2. The attach endpoint calls `promote`, which moves it to its permanent prefix — only for the
 *    same owner and purpose, so nobody can attach someone else's upload.
 * 3. Clients only ever read through `signedUrl`.
 * Unattached temp files are removed by a bucket lifecycle rule on `tmp/` (see docker-compose.yml).
 */
@Service()
export class StorageService {
  async putTemp(ownerId: string, purpose: UploadPurpose, body: Buffer, contentType: string): Promise<string> {
    const key = `tmp/${ownerId}/${purpose}/${randomUUID()}${EXTENSIONS[contentType] ?? ''}`;
    await getS3().send(
      new PutObjectCommand({ Bucket: this.bucket(), Key: key, Body: body, ContentType: contentType }),
    );
    return key;
  }

  /** Stores a file directly at `<prefix>/<uuid>.<ext>` (for single-step uploads such as avatars). */
  async put(prefix: string, body: Buffer, contentType: string): Promise<string> {
    const key = `${prefix}/${randomUUID()}${EXTENSIONS[contentType] ?? ''}`;
    await getS3().send(
      new PutObjectCommand({ Bucket: this.bucket(), Key: key, Body: body, ContentType: contentType }),
    );
    return key;
  }

  /** Moves a temp upload to `<destPrefix>/<file>` and returns the new key. 404 if it isn't this owner's upload. */
  async promote(tempKey: string, owner: { ownerId: string; purpose: UploadPurpose; destPrefix: string }) {
    const expectedPrefix = `tmp/${owner.ownerId}/${owner.purpose}/`;
    const fileName = tempKey.slice(expectedPrefix.length);
    if (!tempKey.startsWith(expectedPrefix) || !/^[\w-]+(\.\w+)?$/.test(fileName)) {
      throw new NotFoundError('errors.file_not_found');
    }

    const bucket = this.bucket();
    const destKey = `${owner.destPrefix}/${fileName}`;
    try {
      await getS3().send(
        new CopyObjectCommand({ Bucket: bucket, CopySource: `${bucket}/${tempKey}`, Key: destKey }),
      );
    } catch (err) {
      if (err instanceof NoSuchKey || (err as { name?: string }).name === 'NoSuchKey') {
        throw new NotFoundError('errors.file_not_found');
      }
      throw err;
    }
    await getS3().send(new DeleteObjectCommand({ Bucket: bucket, Key: tempKey }));
    return destKey;
  }

  signedUrl(key: string, expiresIn = SIGNED_URL_TTL_SECONDS): Promise<string> {
    return getSignedUrl(getS3(), new GetObjectCommand({ Bucket: this.bucket(), Key: key }), { expiresIn });
  }

  async delete(key: string) {
    await getS3().send(new DeleteObjectCommand({ Bucket: this.bucket(), Key: key }));
  }

  private bucket(): string {
    if (!isStorageConfigured()) throw new ServiceUnavailableError();
    return env.storage.bucket;
  }
}
