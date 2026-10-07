import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app';
import { useTestDatabase } from '../helpers/db';
import { createUserWithToken } from '../helpers/fixtures';
import { fakeBucket, sampleFiles, useFakeStorage } from '../helpers/storage';
import { UserRole } from '../../src/interfaces/enums';

useTestDatabase();
useFakeStorage();
const app = createTestApp();

const upload = (auth: string | null, file: Buffer | null, filename: string, purpose?: string) => {
  const req = request(app).post('/api/v1/uploads');
  if (auth) req.set('Authorization', auth);
  if (purpose) req.field('purpose', purpose);
  if (file) req.attach('file', file, filename);
  return req;
};

describe('POST /uploads', () => {
  it('stores the file privately under tmp/<user>/<purpose>/ and returns its key', async () => {
    const { auth, id } = await createUserWithToken();
    const res = await upload(auth, sampleFiles.pdf, 'روشتة.pdf', 'medical_document');
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({
      file_key: expect.stringMatching(new RegExp(`^tmp/${id}/medical_document/[0-9a-f-]{36}\\.pdf$`)),
      mime: 'application/pdf',
      size: sampleFiles.pdf.length,
    });
    expect(fakeBucket.get(res.body.data.file_key)?.contentType).toBe('application/pdf');
  });

  it('checks the real file type, not the name or declared type', async () => {
    const { auth } = await createUserWithToken();
    const res = await upload(auth, sampleFiles.disguisedExe, 'report.pdf', 'medical_document');
    expect(res.status).toBe(422);
    expect(res.body.error.fields).toEqual({ file: ['نوع الملف غير مدعوم، المسموح: JPG أو PNG أو PDF'] });
    expect(fakeBucket.size).toBe(0);
  });

  it('rejects files over 10 MB', async () => {
    const { auth } = await createUserWithToken();
    const big = Buffer.concat([sampleFiles.pdf, Buffer.alloc(10 * 1024 * 1024)]);
    const res = await upload(auth, big, 'big.pdf', 'medical_document');
    expect(res.status).toBe(422);
    expect(res.body.error.fields.file).toEqual(['حجم الملف أكبر من 10 ميجابايت']);
  });

  it('requires a file and a valid purpose', async () => {
    const { auth } = await createUserWithToken();
    expect((await upload(auth, null, '', 'medical_document')).body.error.fields).toEqual({
      file: ['هذا الحقل مطلوب'],
    });
    expect((await upload(auth, sampleFiles.pdf, 'a.pdf')).body.error.fields).toEqual({
      purpose: ['هذا الحقل مطلوب'],
    });
    expect((await upload(auth, sampleFiles.pdf, 'a.pdf', 'selfie')).status).toBe(422);
  });

  it('only accepts images for avatars', async () => {
    const { auth } = await createUserWithToken();
    expect((await upload(auth, sampleFiles.pdf, 'a.pdf', 'avatar')).status).toBe(422);
    expect((await upload(auth, sampleFiles.png, 'a.png', 'avatar')).status).toBe(201);
  });

  it('requires sign-in (any role)', async () => {
    expect((await upload(null, sampleFiles.pdf, 'a.pdf', 'medical_document')).status).toBe(401);
    const { auth } = await createUserWithToken(UserRole.PROVIDER);
    expect((await upload(auth, sampleFiles.jpeg, 'license.jpg', 'provider_document')).status).toBe(201);
  });
});

describe('POST /me/avatar', () => {
  it('sets the photo, returns a signed URL, and removes the previous file', async () => {
    const { auth, id } = await createUserWithToken();
    const first = await request(app)
      .post('/api/v1/me/avatar')
      .set('Authorization', auth)
      .attach('file', sampleFiles.jpeg, 'me.jpg');
    expect(first.status).toBe(200);
    expect(first.body.data.avatar_url).toContain(`avatars/${id}/`);
    expect(first.body.data.avatar_url).toContain('X-Amz-Signature');
    expect(fakeBucket.size).toBe(1);

    await request(app)
      .post('/api/v1/me/avatar')
      .set('Authorization', auth)
      .attach('file', sampleFiles.png, 'me.png')
      .expect(200);
    expect([...fakeBucket.keys()]).toEqual([expect.stringMatching(new RegExp(`^avatars/${id}/.+\\.png$`))]);

    const me = await request(app).get('/api/v1/me').set('Authorization', auth);
    expect(me.body.data.avatar_url).toContain('.png');
  });

  it('refuses PDFs', async () => {
    const { auth } = await createUserWithToken();
    const res = await request(app)
      .post('/api/v1/me/avatar')
      .set('Authorization', auth)
      .attach('file', sampleFiles.pdf, 'me.pdf');
    expect(res.status).toBe(422);
  });
});
