import mongoose from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app';
import { useTestDatabase } from '../helpers/db';
import { createUserWithToken, signUp } from '../helpers/fixtures';
import { fakeBucket, sampleFiles, useFakeStorage } from '../helpers/storage';
import { AuditLogModel } from '../../src/database/models/audit-log/audit-log.model';
import { UserRole } from '../../src/interfaces/enums';

useTestDatabase();
useFakeStorage();
const app = createTestApp();

let auth: string;
let selfId: string;

beforeEach(async () => {
  const session = await signUp(app); // a patient with a "self" profile
  auth = `Bearer ${session.access_token}`;
  const list = await request(app).get('/api/v1/patient-profiles').set('Authorization', auth);
  selfId = list.body.data[0].id;
});

const api = (method: 'get' | 'post' | 'patch' | 'delete', path: string, token = auth) =>
  request(app)[method](`/api/v1${path}`).set('Authorization', token);

const addFather = async () =>
  (
    await api('post', '/patient-profiles').send({
      full_name: 'محمود علي',
      relation: 'father',
      gender: 'male',
      date_of_birth: '1950-06-01',
      blood_type: 'A+',
    })
  ).body.data;

describe('profiles', () => {
  it('starts with the "self" profile and adds family members', async () => {
    const father = await addFather();
    expect(father).toMatchObject({
      full_name: 'محمود علي',
      relation: 'father',
      blood_type: 'A+',
      age: expect.any(Number),
    });

    const list = await api('get', '/patient-profiles');
    expect(list.body.data.map((p: { relation: string }) => p.relation)).toEqual(['self', 'father']);
  });

  it('protects the "self" profile: relation fixed, can’t be deleted, can’t be created twice', async () => {
    expect((await api('patch', `/patient-profiles/${selfId}`).send({ relation: 'father' })).status).toBe(422);
    const del = await api('delete', `/patient-profiles/${selfId}`);
    expect(del.status).toBe(409);
    expect(del.body.error.message).toBe('لا يمكن حذف ملفك الشخصي الأساسي');

    const dup = await api('post', '/patient-profiles').send({
      full_name: 'x',
      relation: 'self',
      gender: 'male',
      date_of_birth: '1990-01-01',
    });
    expect(dup.status).toBe(422);
  });

  it('deletes family members', async () => {
    const father = await addFather();
    await api('delete', `/patient-profiles/${father.id}`).expect(204);
    expect((await api('get', `/patient-profiles/${father.id}`)).status).toBe(404);
  });

  it('is invisible to other users (404, not 403) and closed to non-patients', async () => {
    const stranger = await signUp(app);
    const res = await api('get', `/patient-profiles/${selfId}`, `Bearer ${stranger.access_token}`);
    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe('الملف الشخصي غير موجود');
    expect(
      (await api('get', `/patient-profiles/${selfId}/conditions`, `Bearer ${stranger.access_token}`)).status,
    ).toBe(404);

    const provider = await createUserWithToken(UserRole.PROVIDER);
    expect((await api('get', '/patient-profiles', provider.auth)).status).toBe(403);
  });
});

describe('medical records', () => {
  it('builds a full medical summary', async () => {
    const father = await addFather();
    const base = `/patient-profiles/${father.id}`;
    await api('post', `${base}/conditions`).send({ name: 'سكر', notes: 'نوع ثاني' }).expect(201);
    await api('post', `${base}/medications`)
      .send({ name: 'Glucophage', dosage: '1000mg', frequency: 'مرتين يومياً' })
      .expect(201);
    await api('post', `${base}/allergies`).send({ name: 'بنسلين', severity: 'high' }).expect(201);

    const res = await api('get', base);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      full_name: 'محمود علي',
      conditions: [{ name: 'سكر', notes: 'نوع ثاني' }],
      medications: [{ name: 'Glucophage', dosage: '1000mg', frequency: 'مرتين يومياً', notes: null }],
      allergies: [{ name: 'بنسلين', severity: 'high' }],
      documents_count: 0,
      visit_reports_count: 0,
    });
  });

  it('updates and deletes records, only through their own profile', async () => {
    const father = await addFather();
    const created = await api('post', `/patient-profiles/${father.id}/conditions`).send({ name: 'ضغط' });
    const id = created.body.data.id;

    const updated = await api('patch', `/patient-profiles/${father.id}/conditions/${id}`).send({
      notes: 'منتظم على العلاج',
    });
    expect(updated.body.data).toEqual({ id, name: 'ضغط', notes: 'منتظم على العلاج' });

    // The record isn't reachable through a different profile of the same user.
    expect(
      (await api('patch', `/patient-profiles/${selfId}/conditions/${id}`).send({ notes: 'x' })).status,
    ).toBe(404);

    await api('delete', `/patient-profiles/${father.id}/conditions/${id}`).expect(204);
    expect((await api('get', `/patient-profiles/${father.id}/conditions`)).body.data).toEqual([]);
  });

  it('stores medical text encrypted', async () => {
    const father = await addFather();
    await api('post', `/patient-profiles/${father.id}/conditions`).send({ name: 'سكر', notes: 'نوع ثاني' });
    const raw = await mongoose.connection.collection('medical_conditions').findOne({});
    expect(raw!.name).toMatch(/^enc:v1:/);
    expect(raw!.notes).toMatch(/^enc:v1:/);
    const rawProfile = await mongoose.connection
      .collection('patientprofiles')
      .findOne({ relation: 'father' });
    expect(rawProfile!.bloodType).toMatch(/^enc:v1:/);
  });

  it('audits reads and writes without copying medical values into the audit log', async () => {
    const father = await addFather();
    const created = await api('post', `/patient-profiles/${father.id}/medications`).send({
      name: 'Glucophage',
    });
    await api('patch', `/patient-profiles/${father.id}/medications/${created.body.data.id}`).send({
      dosage: '500mg',
    });
    await api('get', `/patient-profiles/${father.id}`);

    const entries = await AuditLogModel.find({ entityId: father.id }).sort({ createdAt: 1 }).lean();
    expect(entries.map((e) => e.action)).toEqual([
      'medical_record.create', // blood type on the new profile
      'medical_record.create',
      'medical_record.update',
      'medical_profile.read',
    ]);
    expect(entries[2].metadata).toMatchObject({ section: 'medications', fields: ['dosage'] });
    const all = JSON.stringify(entries);
    expect(all).not.toContain('Glucophage');
    expect(all).not.toContain('500mg');
  });
});

describe('medical documents', () => {
  const uploadPdf = async (token = auth, purpose = 'medical_document') =>
    (
      await request(app)
        .post('/api/v1/uploads')
        .set('Authorization', token)
        .field('purpose', purpose)
        .attach('file', sampleFiles.pdf, 'روشتة.pdf')
    ).body.data.file_key as string;

  it('attaches an upload: moved out of tmp/, listed with a signed URL, counted in the summary', async () => {
    const fileKey = await uploadPdf();
    const res = await api('post', `/patient-profiles/${selfId}/documents`).send({
      file_key: fileKey,
      type: 'prescription',
      title: 'روشتة د. سامي',
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      type: 'prescription',
      title: 'روشتة د. سامي',
      mime: 'application/pdf',
    });
    expect(res.body.data.file_url).toContain(`medical-documents/${selfId}/`);
    expect(res.body.data.file_url).toContain('X-Amz-Expires=600');
    expect([...fakeBucket.keys()]).toEqual([expect.stringMatching(`^medical-documents/${selfId}/`)]);

    const list = await api('get', `/patient-profiles/${selfId}/documents`);
    expect(list.body.data).toHaveLength(1);
    expect((await api('get', `/patient-profiles/${selfId}`)).body.data.documents_count).toBe(1);
  });

  it('refuses someone else’s upload, an upload for another purpose, or an unknown key', async () => {
    const stranger = await signUp(app);
    const theirs = await uploadPdf(`Bearer ${stranger.access_token}`);
    const avatar = await (async () =>
      (
        await request(app)
          .post('/api/v1/uploads')
          .set('Authorization', auth)
          .field('purpose', 'avatar')
          .attach('file', sampleFiles.png, 'a.png')
      ).body.data.file_key as string)();

    for (const fileKey of [theirs, avatar, 'tmp/nothing/medical_document/x.pdf']) {
      const res = await api('post', `/patient-profiles/${selfId}/documents`).send({
        file_key: fileKey,
        type: 'other',
      });
      expect(res.status).toBe(404);
      expect(res.body.error.message).toBe('الملف غير موجود');
    }
  });

  it('deleting a document removes its file', async () => {
    const attached = await api('post', `/patient-profiles/${selfId}/documents`).send({
      file_key: await uploadPdf(),
      type: 'lab_result',
    });
    await api('delete', `/patient-profiles/${selfId}/documents/${attached.body.data.id}`).expect(204);
    expect(fakeBucket.size).toBe(0);
    expect((await api('get', `/patient-profiles/${selfId}/documents`)).body.data).toEqual([]);
  });
});
