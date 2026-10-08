/**
 * Creates an admin account (admins can't self-register). They then log in with phone + OTP like everyone else.
 *
 *   npm run admin:create -- --phone +201001234567 --name "Sara Admin"
 *
 * Needs the app's .env (database). Refuses phones that already belong to a non-admin account
 * (spec §2: one role per account).
 */
import 'reflect-metadata';
import { parseArgs } from 'node:util';
import { Container } from 'typedi';
import { connectDB, disconnectDB } from '../database';
import { UserModel } from '../database/models/user/user.model';
import { AdminRole, UserRole } from '../interfaces/enums';
import { EGYPT_MOBILE } from '../services/auth/auth.constants';
import { AuditService, SYSTEM_AUDIT_CONTEXT } from '../services/audit';

const main = async () => {
  const { values } = parseArgs({ options: { phone: { type: 'string' }, name: { type: 'string' } } });
  const phone = values.phone?.trim();
  const name = values.name?.trim();
  if (!phone || !EGYPT_MOBILE.test(phone) || !name) {
    console.error('Usage: npm run admin:create -- --phone +2010XXXXXXXX --name "Full Name"');
    process.exit(1);
  }

  await connectDB();
  try {
    const existing = await UserModel.findOne({ phone }).lean();
    if (existing?.role === UserRole.ADMIN) {
      console.log(`${phone} is already an admin.`);
      return;
    }
    if (existing) {
      console.error(`${phone} belongs to a ${existing.role} account. Use another number for the admin.`);
      process.exitCode = 1;
      return;
    }

    const admin = await UserModel.create({
      phone,
      fullName: name,
      role: UserRole.ADMIN,
      adminRole: AdminRole.SUPER_ADMIN,
    });
    await Container.get(AuditService).log(SYSTEM_AUDIT_CONTEXT, {
      action: 'admin.create',
      entityType: 'user',
      entityId: String(admin._id),
      metadata: { phone, via: 'script' },
    });
    console.log(`Admin created: ${name} (${phone}). They can now log in with an OTP.`);
  } finally {
    await disconnectDB();
  }
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
