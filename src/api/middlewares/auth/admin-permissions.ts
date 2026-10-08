import type { NextFunction, Request, Response } from 'express';
import { AdminRole, UserRole } from '../../../interfaces/enums';
import { ForbiddenError } from '../../../utils/types-errors';

const { VERIFIER, SUPPORT, FINANCE, MARKETING } = AdminRole;
const ALL = [VERIFIER, SUPPORT, FINANCE, MARKETING];

/**
 * Who may do what in the admin panel (spec §7.15 sub-roles; decision M3.5). super_admin may do
 * everything. Each rule: HTTP method(s), the route's path pattern (as registered, e.g.
 * "/admin/bookings/:id/status"), and the other roles allowed. A route with no rule is super_admin only
 * — a deliberate default, checked by tests/unit/admin-permissions.test.ts.
 */
export const ADMIN_RULES: Array<{ methods: string[]; path: RegExp; roles: AdminRole[] }> = [
  // Everyone: the dashboards and the reference lists they need.
  { methods: ['GET'], path: /^\/admin\/(dashboard|attention|analytics)$/, roles: ALL },
  { methods: ['GET'], path: /^\/admin\/(service-categories|services|governorates|areas)$/, roles: ALL },

  // Verification.
  { methods: ['GET', 'POST'], path: /^\/admin\/verifications(\/|$)/, roles: [VERIFIER] },
  { methods: ['POST'], path: /^\/admin\/documents\/:id\/review$/, roles: [VERIFIER] },

  // Providers, organizations, users.
  {
    methods: ['GET'],
    path: /^\/admin\/(providers|organizations)(\/:id)?$/,
    roles: [VERIFIER, SUPPORT, FINANCE],
  },
  { methods: ['PATCH'], path: /^\/admin\/providers\/:id$/, roles: [VERIFIER, SUPPORT] },
  // Organization edits include its commission rate.
  { methods: ['PATCH'], path: /^\/admin\/organizations\/:id$/, roles: [FINANCE] },
  { methods: ['GET'], path: /^\/admin\/users(\/:id(\/history)?)?$/, roles: [VERIFIER, SUPPORT, FINANCE] },
  { methods: ['POST'], path: /^\/admin\/users\/:id\/(suspend|warn|activate)$/, roles: [SUPPORT] },

  // Bookings, disputes, reviews. Booking chats are support's (health details; audited).
  { methods: ['GET'], path: /^\/admin\/bookings(\/:id)?$/, roles: [SUPPORT, FINANCE] },
  { methods: ['GET'], path: /^\/admin\/bookings\/:id\/conversations$/, roles: [SUPPORT] },
  { methods: ['POST'], path: /^\/admin\/bookings\/:id\/(status|reassign)$/, roles: [SUPPORT] },
  { methods: ['GET'], path: /^\/admin\/disputes(\/:id)?$/, roles: [SUPPORT, FINANCE] },
  { methods: ['POST'], path: /^\/admin\/disputes\/:id\/resolve$/, roles: [SUPPORT] },
  { methods: ['GET', 'PATCH'], path: /^\/admin\/reviews(\/:id)?$/, roles: [SUPPORT] },

  // Money.
  { methods: ['POST'], path: /^\/admin\/bookings\/:id\/refund$/, roles: [FINANCE] },
  { methods: ['GET'], path: /^\/admin\/(payments|commission-dues|reports\/export)$/, roles: [FINANCE] },
  { methods: ['GET', 'POST'], path: /^\/admin\/payouts(\/|$)/, roles: [FINANCE] },
  { methods: ['POST'], path: /^\/admin\/ledger\/adjustment$/, roles: [FINANCE] },
  { methods: ['GET'], path: /^\/admin\/subscription-plans$/, roles: [FINANCE, MARKETING] },

  // Marketing. (Service announcements: super_admin only — checked by the broadcast service.)
  {
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    path: /^\/admin\/(promo-codes|banners|packages)(\/:id)?$/,
    roles: [MARKETING],
  },
  { methods: ['POST'], path: /^\/admin\/notifications\/broadcast$/, roles: [MARKETING] },
  { methods: ['GET'], path: /^\/admin\/notifications\/broadcasts$/, roles: [MARKETING] },
];

/** The roles (besides super_admin) allowed on a route; [] = super_admin only. */
export const rolesFor = (method: string, path: string) =>
  ADMIN_RULES.find((r) => r.methods.includes(method) && r.path.test(path))?.roles ?? [];

export const adminCan = (role: AdminRole | null | undefined, method: string, path: string) =>
  !role || role === AdminRole.SUPER_ADMIN
    ? role === AdminRole.SUPER_ADMIN
    : rolesFor(method, path).includes(role);

/** Booking notes, dispute descriptions and chats may describe a patient's health. */
export const canReadHealthText = (role: AdminRole | null | undefined) =>
  role === AdminRole.SUPER_ADMIN || role === AdminRole.SUPPORT;

/** After Auth(ADMIN): the admin's sub-role must be allowed on this route. */
export const AdminPermissionMiddleware = (req: Request, _res: Response, next: NextFunction) => {
  if (req.user?.role !== UserRole.ADMIN) return next(new ForbiddenError());
  const path = (req.route as { path?: string } | undefined)?.path ?? req.path;
  if (!adminCan(req.user.adminRole, req.method, path))
    return next(new ForbiddenError('errors.admin_permission'));
  next();
};
