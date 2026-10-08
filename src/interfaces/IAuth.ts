import type { Types } from 'mongoose';
import type { DevicePlatform } from './enums';

export enum OtpPurpose {
  LOGIN = 'login',
  PHONE_CHANGE = 'phone_change',
}

/** Spec §4.1 `otp_codes`. The code itself is never stored, only an HMAC of it. */
export interface IOtpCode {
  _id: Types.ObjectId;
  phone: string;
  purpose: OtpPurpose;
  /** Set for phone changes: the account the new number will move to. */
  userId: Types.ObjectId | null;
  codeHash: string;
  expiresAt: Date;
  attempts: number;
  consumedAt: Date | null;
  /** A test number's fixed code (no SMS sent); its use is audited. */
  fixedCode?: boolean;
  createdAt: Date;
}

/**
 * One refresh token per row, stored hashed. A login starts a `familyId` (= one session on one device);
 * every refresh revokes the used token and issues the next one in the same family.
 */
export interface IRefreshToken {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  familyId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
}

/** Spec §4.1 `devices`: FCM tokens for push. */
export interface IDevice {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  fcmToken: string;
  platform: DevicePlatform;
  appVersion: string | null;
  lastSeenAt: Date;
  createdAt: Date;
  updatedAt: Date;
}
