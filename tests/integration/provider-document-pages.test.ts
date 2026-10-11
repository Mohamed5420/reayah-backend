import request from 'supertest';
import { Container } from 'typedi';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app';
import { useTestDatabase } from '../helpers/db';
import { signUp } from '../helpers/fixtures';
import { sampleFiles, useFakeStorage } from '../helpers/storage';
import { runSeeds } from '../../src/database/seed';
import { ProviderProfileModel } from '../../src/database/models/provider/provider-profile.model';
import { ProviderDocumentModel } from '../../src/database/models/provider/provider-document.model';
import { UserRole } from '../../src/interfaces/enums';
import { SettingsService } from '../../src/services/settings';
import { DocumentExpiryService } from '../../src/services/provider';

/** Provider documents (M21): a back page for cards, and the criminal record certificate. */

useTestDatabase();
useFakeStorage();
const app = createTestApp();

let auth: string;
let userId: string;

const fileKey = async () =>
  (
    await request(app)
      .post('/api/v1/uploads')
      .set('Authorization', auth)
      .field('purpose', 'provider_document')
      .attach('file', sampleFiles.jpeg, 'page.jpg')
  ).body.data.file_key as string;
const attach = (body: object) =>
  request(app).post('/api/v1/provider/documents').set('Authorization', auth).send(body);
const onboarding = async () =>
  (await request(app).get('/api/v1/provider/profile').set('Authorization', auth)).body.data.onboarding;

beforeEach(async () => {
  await runSeeds();
  const session = await signUp(app, UserRole.PROVIDER);
  auth = `Bearer ${session.access_token}`;
  userId = session.user.id;
});

describe('document pages', () => {
  it('a card takes an optional back page; the ID card sides are separate types and take none', async () => {
    const card = await attach({
      type: 'syndicate_card',
      file_key: await fileKey(),
      back_file_key: await fileKey(),
    });
    expect(card.status).toBe(201);
    expect(card.body.data).toMatchObject({ type: 'syndicate_card', back_mime: 'image/jpeg' });
    expect(card.body.data.back_file_url).toEqual(expect.any(String));
    const listed = (await request(app).get('/api/v1/provider/documents').set('Authorization', auth)).body
      .data;
    expect(listed[0].back_file_url).toEqual(expect.any(String));

    const single = await attach({ type: 'license', file_key: await fileKey() });
    expect(single.body.data).toMatchObject({ back_file_url: null, back_mime: null });

    const id = await attach({
      type: 'national_id_front',
      file_key: await fileKey(),
      back_file_key: await fileKey(),
    });
    expect(id.status).toBe(422);
    expect(id.body.error.fields).toHaveProperty('back_file_key');
  });
});

describe('criminal record', () => {
  const upload = async (type: string) => (await attach({ type, file_key: await fileKey() })).status;

  it('optional by default; once required it is needed to submit, and when it expires the provider is paused', async () => {
    for (const type of ['license', 'syndicate_card', 'national_id_front', 'national_id_back']) {
      expect(await upload(type)).toBe(201);
    }
    expect((await onboarding()).documents_uploaded).toBe(true);

    await Container.get(SettingsService).update({ criminal_record_required: true }, { actorId: null });
    expect((await onboarding()).documents_uploaded).toBe(false);
    const record = await attach({
      type: 'criminal_record',
      file_key: await fileKey(),
      expires_at: '2030-01-01',
    });
    expect(record.status).toBe(201);
    expect((await onboarding()).documents_uploaded).toBe(true);

    // Expired while required → no new bookings until a valid one is approved.
    await ProviderProfileModel.updateOne(
      { userId },
      { verificationStatus: 'approved', isAcceptingBookings: true },
    );
    await ProviderDocumentModel.updateOne(
      { _id: record.body.data.id },
      { expiresAt: new Date(Date.now() - 1000) },
    );
    await Container.get(DocumentExpiryService).processDaily();
    expect((await ProviderProfileModel.findOne({ userId }).lean())!.isAcceptingBookings).toBe(false);
  });
});
