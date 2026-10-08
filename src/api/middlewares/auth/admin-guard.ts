import { UserRole } from '../../../interfaces/enums';
import { IsAuthenticatedMiddleware } from './is-authenticated.middleware';
import { RequireActiveAccountMiddleware } from './require-active-account.middleware';
import { RequireRole } from './require-role.middleware';
import { AdminPermissionMiddleware } from './admin-permissions';

/**
 * The standard auth chain: valid access token → active account → (optionally) one of `roles`.
 * Spread it after the validator: `CheckAppStatusMiddleware, r.validate, ...Auth(UserRole.PATIENT), handler`.
 */
export const Auth = (...roles: UserRole[]) => [
  IsAuthenticatedMiddleware,
  RequireActiveAccountMiddleware,
  ...(roles.length ? [RequireRole(...roles)] : []),
];

/** Admin-panel routes: an admin whose sub-role is allowed on the route (see `admin-permissions.ts`). */
export const AdminGuard = [...Auth(UserRole.ADMIN), AdminPermissionMiddleware];
