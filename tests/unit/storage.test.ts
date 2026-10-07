import { describe, expect, it } from 'vitest';
import { Container } from 'typedi';
import { StorageService } from '../../src/services/storage';

// No S3 server needed: URL signing is offline, and ownership checks run before any network call.
const storage = Container.get(StorageService);
const owner = { ownerId: 'ME', purpose: 'avatar' as const, destPrefix: 'avatars/ME' };

describe('StorageService', () => {
  it('signs read URLs valid for 10 minutes', async () => {
    const url = await storage.signedUrl('provider-docs/p1/abc.pdf');
    expect(url).toContain('reaya-test');
    expect(url).toContain('X-Amz-Expires=600');
    expect(url).toContain('X-Amz-Signature');
  });

  it.each([
    ['another owner', 'tmp/OTHER/avatar/x.jpg'],
    ['another purpose', 'tmp/ME/chat/x.jpg'],
    ['path traversal', 'tmp/ME/avatar/../../etc'],
    ['a non-temp key', 'avatars/ME/x.jpg'],
  ])('refuses to promote %s', async (_case, key) => {
    await expect(storage.promote(key, owner)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
