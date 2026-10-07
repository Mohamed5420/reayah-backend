import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Service } from 'typedi';
import { RefreshTokenModel } from '../../database/models/auth/refresh-token.model';
import { UserModel } from '../../database/models/user/user.model';
import { UserStatus } from '../../interfaces/enums';
import type { IUser } from '../../interfaces/IUser';
import { env } from '../../config/env.config';
import { logger } from '../../utils/logger/winston';
import { AccountSuspendedError, UnauthorizedError } from '../../utils/types-errors';
import { signAccessToken } from './jwt';

export type SessionTokens = { access_token: string; refresh_token: string; expires_in: number };

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * Sessions = access JWT (short) + opaque refresh token (long, rotating, stored hashed).
 * Presenting an already-used refresh token means it was copied: the whole session (family) is revoked.
 * Clients must therefore never refresh twice in parallel with the same token.
 */
@Service()
export class TokenService {
  /** Starts a new session (new family) for a login or sign-up. */
  startSession(user: Pick<IUser, '_id' | 'role' | 'language'>): Promise<SessionTokens> {
    return this.issue(user, randomUUID());
  }

  /** Exchanges a refresh token for a new pair. 401 if unknown/expired/reused; 403 if the account is suspended. */
  async rotate(refreshToken: string): Promise<SessionTokens> {
    const tokenHash = hashToken(refreshToken);
    const now = new Date();
    const current = await RefreshTokenModel.findOneAndUpdate(
      { tokenHash, revokedAt: null, expiresAt: { $gt: now } },
      { revokedAt: now },
    );

    if (!current) {
      const known = await RefreshTokenModel.findOne({ tokenHash }).lean();
      if (known?.revokedAt) {
        logger.warn(`Refresh token reuse detected — revoking session ${known.familyId}`);
        await this.revokeFamily(known.familyId);
      }
      throw new UnauthorizedError('errors.invalid_refresh_token');
    }

    const user = await UserModel.findById(current.userId).lean();
    if (!user || user.status === UserStatus.DELETED) {
      await this.revokeFamily(current.familyId);
      throw new UnauthorizedError('errors.invalid_refresh_token');
    }
    if (user.status !== UserStatus.ACTIVE) {
      await this.revokeFamily(current.familyId);
      throw new AccountSuspendedError();
    }
    return this.issue(user, current.familyId);
  }

  /** Logout: ends the session the token belongs to. Returns its user id, or null for unknown tokens. */
  async revokeSession(refreshToken: string): Promise<string | null> {
    const token = await RefreshTokenModel.findOne({ tokenHash: hashToken(refreshToken) }).lean();
    if (!token) return null;
    await this.revokeFamily(token.familyId);
    return String(token.userId);
  }

  /** Ends every session of a user (account deletion, suspension). */
  async revokeAllForUser(userId: string) {
    await RefreshTokenModel.updateMany({ userId, revokedAt: null }, { revokedAt: new Date() });
  }

  private async revokeFamily(familyId: string) {
    await RefreshTokenModel.updateMany({ familyId, revokedAt: null }, { revokedAt: new Date() });
  }

  private async issue(
    user: Pick<IUser, '_id' | 'role' | 'language'>,
    familyId: string,
  ): Promise<SessionTokens> {
    const refreshToken = randomBytes(32).toString('base64url');
    await RefreshTokenModel.create({
      userId: user._id,
      familyId,
      tokenHash: hashToken(refreshToken),
      expiresAt: new Date(Date.now() + env.jwt.refreshTokenTtlDays * 24 * 3600 * 1000),
    });
    return {
      access_token: signAccessToken({ id: String(user._id), role: user.role, language: user.language }),
      refresh_token: refreshToken,
      expires_in: env.jwt.accessTokenTtlSeconds,
    };
  }
}
