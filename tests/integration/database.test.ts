import mongoose, { Schema, model } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { useTestDatabase } from '../helpers/db';
import { createUser } from '../helpers/fixtures';
import { UserModel } from '../../src/database/models/user/user.model';
import { AuditLogModel } from '../../src/database/models/audit-log/audit-log.model';
import { decryptField, encryptedString } from '../../src/utils/crypto/field-encryption';
import { Gender, UserRole } from '../../src/interfaces/enums';

useTestDatabase();

describe('replica set', () => {
  it('supports transactions', async () => {
    const session = await mongoose.startSession();
    await session.withTransaction(async () => {
      await UserModel.create(
        [
          {
            phone: '+201000000001',
            fullName: 'Tx',
            gender: Gender.MALE,
            dateOfBirth: new Date('1990-01-01'),
            role: UserRole.PATIENT,
          },
        ],
        { session },
      );
    });
    await session.endSession();
    expect(await UserModel.exists({ phone: '+201000000001' })).toBeTruthy();
  });

  it('rolls back everything when the transaction fails', async () => {
    const session = await mongoose.startSession();
    await expect(
      session.withTransaction(async () => {
        await UserModel.create([{ phone: '+201000000002', fullName: 'Tx', role: UserRole.ADMIN }], {
          session,
        });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await session.endSession();
    expect(await UserModel.exists({ phone: '+201000000002' })).toBeNull();
  });
});

describe('softDeletePlugin', () => {
  it('hides soft-deleted documents from reads, counts and aggregations', async () => {
    const user = await createUser();
    await createUser();
    await user.softDelete();

    expect(await UserModel.findById(user._id)).toBeNull();
    expect(await UserModel.countDocuments()).toBe(1);
    expect(await UserModel.aggregate([{ $match: {} }])).toHaveLength(1);
  });

  it('includes them on request or when filtering on deletedAt', async () => {
    const user = await createUser();
    await user.softDelete();

    expect(await UserModel.find().setOptions({ withDeleted: true })).toHaveLength(1);
    expect(await UserModel.find({ deletedAt: { $ne: null } })).toHaveLength(1);
  });

  it('does not update deleted documents, and restore() brings them back', async () => {
    const user = await createUser();
    await user.softDelete();
    expect((await UserModel.updateOne({ _id: user._id }, { name: 'X' })).matchedCount).toBe(0);

    const deleted = await UserModel.findById(user._id).setOptions({ withDeleted: true });
    await deleted!.restore();
    expect(await UserModel.findById(user._id)).not.toBeNull();
  });
});

describe('audit_logs', () => {
  it('is append-only', async () => {
    await AuditLogModel.create({ actorId: null, action: 'test.do', entityType: 'thing' });
    await expect(AuditLogModel.updateOne({}, { action: 'changed' })).rejects.toThrow('append-only');
  });
});

describe('encryptedString', () => {
  type ISecret = { license: string };
  const Secret = model<ISecret>(
    'TestSecret',
    new Schema<ISecret>({ license: encryptedString({ required: true }) }, { toJSON: { getters: true } }),
  );
  const rawLicense = async (id: unknown) =>
    (await mongoose.connection.collection('testsecrets').findOne({ _id: id as never }))!.license as string;

  it('stores ciphertext and reads plaintext', async () => {
    const doc = await Secret.create({ license: 'LIC-123' });
    expect(await rawLicense(doc._id)).toMatch(/^enc:v1:/);
    expect((await Secret.findById(doc._id))!.license).toBe('LIC-123');
    expect(doc.toJSON().license).toBe('LIC-123');
  });

  it('encrypts values written through updateOne', async () => {
    const doc = await Secret.create({ license: 'LIC-123' });
    await Secret.updateOne({ _id: doc._id }, { license: 'LIC-999' });
    expect(decryptField(await rawLicense(doc._id))).toBe('LIC-999');
  });
});
