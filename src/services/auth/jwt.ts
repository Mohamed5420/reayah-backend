import jwt from 'jsonwebtoken';
import { env } from '../../config/env.config';
import type { IAuthUser } from '../../interfaces/IUser';
import type { UserRole } from '../../interfaces/enums';
import type { Language } from '../../utils/i18n';
import { TokenExpiredError, UnauthorizedError } from '../../utils/types-errors';
import { REGISTRATION_TOKEN_TTL_SECONDS } from './auth.constants';

/** `typ` keeps the two token kinds apart: a registration token can never be used as an access token. */
type AccessPayload = { sub: string; role: UserRole; lang: Language; typ: 'access' };
type RegistrationPayload = { sub: string; typ: 'registration' };

const ALGORITHM = 'HS256';

export const signAccessToken = (user: { id: string; role: UserRole; language: Language }) =>
  jwt.sign(
    { sub: user.id, role: user.role, lang: user.language, typ: 'access' } satisfies AccessPayload,
    env.jwt.secret,
    {
      algorithm: ALGORITHM,
      expiresIn: env.jwt.accessTokenTtlSeconds,
    },
  );

/** 401 TOKEN_EXPIRED when expired (client should refresh), 401 UNAUTHENTICATED for anything else. */
export const verifyAccessToken = (token: string): IAuthUser => {
  const payload = verify(token);
  if (payload.typ !== 'access' || typeof payload.sub !== 'string') throw new UnauthorizedError();
  const { sub, role, lang } = payload as AccessPayload;
  return { id: sub, role, language: lang };
};

export const signRegistrationToken = (phone: string) =>
  jwt.sign({ sub: phone, typ: 'registration' } satisfies RegistrationPayload, env.jwt.secret, {
    algorithm: ALGORITHM,
    expiresIn: REGISTRATION_TOKEN_TTL_SECONDS,
  });

/** Returns the verified phone number. */
export const verifyRegistrationToken = (token: string): string => {
  let payload: jwt.JwtPayload;
  try {
    payload = verify(token);
  } catch {
    throw new UnauthorizedError('errors.invalid_registration_token');
  }
  if (payload.typ !== 'registration' || typeof payload.sub !== 'string') {
    throw new UnauthorizedError('errors.invalid_registration_token');
  }
  return payload.sub;
};

const verify = (token: string): jwt.JwtPayload => {
  try {
    const payload = jwt.verify(token, env.jwt.secret, { algorithms: [ALGORITHM] });
    if (typeof payload === 'string') throw new UnauthorizedError();
    return payload;
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) throw new TokenExpiredError();
    throw new UnauthorizedError();
  }
};
