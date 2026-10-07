import { afterEach, beforeEach, vi } from 'vitest';
import { getS3 } from '../../src/config/storage.config';

/** What the fake bucket holds: key → stored object. Inspect it in assertions. */
export const fakeBucket = new Map<string, { body: Buffer; contentType?: string }>();

type S3Command = { constructor: { name: string }; input: Record<string, unknown> };

/**
 * Replaces S3 with an in-memory bucket for the file's tests (Put, Copy, Delete). URL signing needs no
 * network, so signed URLs are real.
 */
export const useFakeStorage = () => {
  beforeEach(() => {
    fakeBucket.clear();
    vi.spyOn(getS3(), 'send').mockImplementation((async (command: S3Command) => {
      const input = command.input;
      switch (command.constructor.name) {
        case 'PutObjectCommand':
          fakeBucket.set(input.Key as string, {
            body: input.Body as Buffer,
            contentType: input.ContentType as string,
          });
          return {};
        case 'CopyObjectCommand': {
          const source = input.CopySource as string;
          const object = fakeBucket.get(source.slice(source.indexOf('/') + 1));
          if (!object) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
          fakeBucket.set(input.Key as string, object);
          return {};
        }
        case 'DeleteObjectCommand':
          fakeBucket.delete(input.Key as string);
          return {};
        default:
          throw new Error(`Unexpected S3 command in tests: ${command.constructor.name}`);
      }
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
};

/** Small files whose first bytes match the real formats. */
export const sampleFiles = {
  pdf: Buffer.from('%PDF-1.4\n% test document\n%%EOF'),
  jpeg: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]),
  png: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]),
  /** A Windows executable renamed to .pdf. */
  disguisedExe: Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64)]),
};
