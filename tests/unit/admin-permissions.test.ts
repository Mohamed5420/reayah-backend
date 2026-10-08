import { describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app';
import { routeCatalog } from '../../src/docs/openapi';
import {
  ADMIN_RULES,
  adminCan,
  canReadHealthText,
  rolesFor,
} from '../../src/api/middlewares/auth/admin-permissions';
import { AdminRole } from '../../src/interfaces/enums';

createTestApp(); // constructs every controller, which fills the route catalog
const adminRoutes = () =>
  routeCatalog()
    .filter((r) => r.path.startsWith('/admin/'))
    .map((r) => ({ method: r.method.toUpperCase(), path: r.path }));

describe('admin sub-role permissions (decision M3.5)', () => {
  it('the full table: who besides super_admin may use each admin route', () => {
    // Reviewing a change here is the point: a new admin route is super_admin only until a rule says otherwise.
    const table = adminRoutes()
      .map((r) => `${r.method} ${r.path} → ${rolesFor(r.method, r.path).join(', ') || 'super_admin only'}`)
      .sort();
    expect(table).toMatchSnapshot();
  });

  it('every rule matches at least one real route (no dead or misspelled rules)', () => {
    const routes = adminRoutes();
    for (const rule of ADMIN_RULES) {
      for (const method of rule.methods) {
        const hits = routes.filter((r) => r.method === method && rule.path.test(r.path));
        expect(hits.length, `${method} ${rule.path.source}`).toBeGreaterThan(0);
      }
    }
  });

  it('admin accounts, settings, audit logs and catalog writes stay super_admin only', () => {
    const superOnly = adminRoutes().filter(
      (r) =>
        /^\/admin\/(admins|settings|audit-logs)/.test(r.path) ||
        (r.method !== 'GET' &&
          /^\/admin\/(service-categories|services|governorates|areas|subscription-plans)/.test(r.path)),
    );
    expect(superOnly.length).toBeGreaterThan(5);
    for (const r of superOnly) expect(rolesFor(r.method, r.path), `${r.method} ${r.path}`).toEqual([]);
  });

  it('super_admin can do everything; a missing role can do nothing', () => {
    for (const r of adminRoutes()) {
      expect(adminCan(AdminRole.SUPER_ADMIN, r.method, r.path)).toBe(true);
      expect(adminCan(null, r.method, r.path)).toBe(false);
    }
    expect(adminCan(AdminRole.FINANCE, 'POST', '/admin/payouts/generate')).toBe(true);
    expect(adminCan(AdminRole.SUPPORT, 'POST', '/admin/payouts/generate')).toBe(false);
    expect(adminCan(AdminRole.MARKETING, 'POST', '/admin/notifications/broadcast')).toBe(true);
  });

  it('health text (booking notes, dispute descriptions) only for super_admin and support', () => {
    expect(Object.values(AdminRole).filter(canReadHealthText)).toEqual([
      AdminRole.SUPER_ADMIN,
      AdminRole.SUPPORT,
    ]);
  });
});
