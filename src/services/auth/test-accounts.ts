import { env } from '../../config/env.config';
import { UserModel } from '../../database/models/user/user.model';
import { OtpPurpose } from '../../interfaces/IAuth';
import { UserRole } from '../../interfaces/enums';
import { EGYPT_MOBILE, OTP } from './auth.constants';

/**
 * Test numbers (launch decision): app-store reviewers and testers can't receive our SMS, so numbers on
 * the `TEST_PHONE_NUMBERS` allowlist sign in with the fixed `TEST_OTP_CODE` (no SMS is sent). Every
 * fixed-code issue and sign-in is audited. Accounts made this way are flagged `isTestAccount`.
 *
 * Production rules — the fixed code never opens a real account:
 * - it works only for a number with no account yet (a new test account) or one already flagged test,
 *   never for a real account that happens to use an allowlisted number, and never for an admin;
 * - changing a phone to a test number by fixed code is allowed only for a test account;
 * - test accounts are kept apart: test patients only find and book test providers / organizations,
 *   and real patients never see those (`sameWorld`).
 * Elsewhere (development, staging) allowlisted numbers simply use the fixed code, and nothing is kept apart.
 */

const validateConfig = () => {
  const { phones, code } = env.testAccounts;
  if (!phones.length) return;
  const bad = phones.filter((p) => !EGYPT_MOBILE.test(p));
  if (bad.length) throw new Error(`TEST_PHONE_NUMBERS: not Egyptian mobile numbers: ${bad.join(', ')}`);
  if (!new RegExp(`^\\d{${OTP.LENGTH}}$`).test(code)) {
    throw new Error(`TEST_OTP_CODE must be ${OTP.LENGTH} digits when TEST_PHONE_NUMBERS is set`);
  }
};
validateConfig();

const allowlist = new Set(env.testAccounts.phones);

export const isTestPhone = (phone: string) => allowlist.has(phone);

let isolationOverride: boolean | null = null;
/** Tests only: apply (or not) the production rules. null = by environment. */
export const setTestAccountIsolationForTests = (on: boolean | null) => {
  isolationOverride = on;
};
/** The production rules above; on in production only (tests switch them on with the override). */
const productionRules = () => isolationOverride ?? env.isProduction;

/**
 * Whether this OTP may use the fixed code. `userId` is the requester for a phone change.
 * Returns false (→ a normal SMS code) whenever a rule says no.
 */
export const fixedCodeAllowed = async (phone: string, purpose: OtpPurpose, userId?: string) => {
  if (!isTestPhone(phone)) return false;
  if (purpose === OtpPurpose.PHONE_CHANGE) {
    if (!productionRules()) return true;
    const requester = await UserModel.findById(userId).select('isTestAccount role').lean();
    return Boolean(requester?.isTestAccount) && requester?.role !== UserRole.ADMIN;
  }
  const account = await UserModel.findOne({ phone }).select('isTestAccount role').lean();
  if (!account) return true;
  if (account.role === UserRole.ADMIN && productionRules()) return false;
  return !productionRules() || account.isTestAccount;
};

/**
 * A query filter keeping test and real accounts apart (profiles, organizations): in production, a test
 * caller sees only test rows and everyone else only real ones. No-op elsewhere.
 */
export const sameWorld = (callerIsTest: boolean | undefined) =>
  !productionRules() ? {} : callerIsTest ? { isTestAccount: true } : { isTestAccount: { $ne: true } };

/** The same rule for one row already loaded. */
export const inSameWorld = (callerIsTest: boolean | undefined, rowIsTest: boolean | undefined) =>
  !productionRules() || Boolean(callerIsTest) === Boolean(rowIsTest);
