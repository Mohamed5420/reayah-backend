import jwt from 'jsonwebtoken';
import { Server } from '../../src/server';
import { getGlobalControllers } from '../../src/api/controllers';
import { env } from '../../src/config/env.config';
import { UserRole } from '../../src/interfaces/enums';

/** The real Express app (all middlewares and controllers), without listening or connecting anything. */
export const createTestApp = () => new Server(getGlobalControllers()).app;

/** Access token for `Authorization: Bearer ...`. Negative `expiresInSeconds` gives an already-expired token. */
export const signTestToken = (user: { id: string; role?: UserRole }, expiresInSeconds = 3600) =>
  jwt.sign({ sub: user.id, role: user.role ?? UserRole.PATIENT, lang: 'ar', typ: 'access' }, env.jwt.secret, {
    algorithm: 'HS256',
    expiresIn: expiresInSeconds,
  });
