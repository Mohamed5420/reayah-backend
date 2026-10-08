import type { Types } from 'mongoose';
import type { Language } from '../utils/i18n';
import type { AdminRole, Gender, UserRole, UserStatus } from './enums';
import type { INotificationSettings } from './INotification';

export { UserRole, UserStatus } from './enums';

/** Spec §4.1 `users`. One role per account (spec §2). Login is phone + OTP only — no passwords. */
export interface IUser {
  _id: Types.ObjectId;
  /** E.164, unique among non-deleted accounts. */
  phone: string;
  fullName: string;
  email: string | null;
  /** Required for everyone except admins (created by script, not sign-up). */
  gender: Gender | null;
  dateOfBirth: Date | null;
  role: UserRole;
  language: Language;
  avatarKey: string | null;
  status: UserStatus;
  lastLoginAt: Date | null;
  /** Referral code entered at sign-up; rewarded after the first completed booking (Phase 2). */
  referredByCode: string | null;
  /** Admins only: their sub-role (null for everyone else; older admin accounts count as super_admin). */
  adminRole: AdminRole | null;
  /** Signed up with an allowlisted test number (reviewers, testers). Kept apart from real users in production. */
  isTestAccount: boolean;
  /** This user's own code to invite others (created on first GET /me/referral). */
  referralCode: string | null;
  deletionRequestedAt: Date | null;
  isOnline: boolean;
  notificationSettings: INotificationSettings;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/** Shape attached to `req.user` after authentication (from the access token). */
export interface IAuthUser {
  id: string;
  role: UserRole;
  /** Saved language, used when the request has no supported `Accept-Language`. */
  language?: Language;
  /** Admins: their sub-role, read from the database on each request. */
  adminRole?: AdminRole | null;
  isTestAccount?: boolean;
}
