import fs from 'node:fs';
import path from 'node:path';
import type { Express, RequestHandler } from 'express';
import mongoose, { type Schema } from 'mongoose';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app';
import { useTestDatabase } from '../helpers/db';
import { createUserWithToken } from '../helpers/fixtures';
import { buildOpenApiDocument, routeCatalog } from '../../src/docs/openapi';
import { IsAuthenticatedMiddleware } from '../../src/api/middlewares/auth/is-authenticated.middleware';
import { AdminPermissionMiddleware } from '../../src/api/middlewares/auth/admin-permissions';
import { RequireActiveAccountMiddleware } from '../../src/api/middlewares/auth/require-active-account.middleware';
import { decryptField, isEncrypted } from '../../src/utils/crypto/field-encryption';
import { UserRole } from '../../src/interfaces/enums';

/**
 * M1.9 security pass (spec §9) as tests, so it keeps holding as the API grows:
 * auth on every non-public route, role guards on admin / provider routes, no location data anywhere,
 * sensitive fields encrypted, per-IP rate limits.
 */

useTestDatabase();
const app = createTestApp();
const prefix = '/api/v1';

/** The only routes reachable without an access token. Adding one here is a deliberate decision. */
const PUBLIC_ROUTES = new Set([
  'GET /health',
  'GET /health/ready',
  'GET /health/jobs', // job names + last run only — for alerting
  'GET /app-config',
  'GET /governorates',
  'GET /governorates/:id/areas',
  'GET /areas',
  'GET /service-categories',
  'GET /services',
  'GET /services/:id',
  'GET /specialties',
  'POST /auth/otp/request',
  'POST /auth/otp/verify',
  'POST /auth/register', // carries its own short-lived registration token
  'POST /auth/refresh', // carries the refresh token
  'POST /auth/logout', // carries the refresh token
  'POST /webhooks/payments/:gateway', // the gateway's callback, authenticated by its signature
  'GET /payments/:id/return', // browser bounce back into the app; reveals nothing
]);

type MountedRoute = { method: string; path: string; handlers: RequestHandler[] };

/** Every route as Express mounted it, with its middleware chain. */
const mountedRoutes = (express: Express): MountedRoute[] => {
  type Layer = {
    route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: RequestHandler }> };
    handle: { stack?: Layer[] };
  };
  const routes: MountedRoute[] = [];
  const walk = (stack: Layer[]) => {
    for (const layer of stack) {
      if (layer.route) {
        for (const method of Object.keys(layer.route.methods)) {
          routes.push({
            method: method.toUpperCase(),
            path: layer.route.path,
            handlers: layer.route.stack.map((l) => l.handle),
          });
        }
      } else if (layer.handle.stack) {
        walk(layer.handle.stack);
      }
    }
  };
  walk((express as unknown as { _router: { stack: Layer[] } })._router.stack);
  return routes;
};

const key = (r: { method: string; path: string }) => `${r.method.toUpperCase()} ${r.path}`;
const sample = (p: string) => p.replace(/:\w+/g, '665f1c2b9e1d2a4c3b9e8f1a');

describe('authentication on every route', () => {
  const declared = routeCatalog();
  const mounted = mountedRoutes(app).filter((r) => declared.some((d) => key(d) === key(r)));

  it('every declared route is mounted, and the public list has no stale entries', () => {
    expect(declared.length).toBeGreaterThan(140);
    expect(mounted.map(key).sort()).toEqual([...new Set(declared.map(key))].sort());
    for (const route of PUBLIC_ROUTES) expect(declared.map(key), route).toContain(route);
  });

  it('non-public routes run the token check and the active-account check; docs agree', () => {
    const problems: string[] = [];
    for (const route of mounted) {
      const isPublic = PUBLIC_ROUTES.has(key(route));
      const hasAuth =
        route.handlers.includes(IsAuthenticatedMiddleware) &&
        route.handlers.includes(RequireActiveAccountMiddleware);
      const documented = declared.find((d) => key(d) === key(route))!.auth === true;
      if (!isPublic && !hasAuth) problems.push(`${key(route)}: no auth middleware`);
      if (isPublic && hasAuth) problems.push(`${key(route)}: listed as public but requires auth`);
      if (!isPublic && !documented) problems.push(`${key(route)}: not documented as auth in OpenAPI`);
    }
    expect(problems).toEqual([]);
  });

  it('protected GET routes answer 401 without a token', async () => {
    const protectedGets = mounted.filter((r) => r.method === 'GET' && !PUBLIC_ROUTES.has(key(r)));
    expect(protectedGets.length).toBeGreaterThan(50);
    for (const route of protectedGets) {
      const res = await request(app).get(prefix + sample(route.path));
      // Required query params are validated first (422) — never a 2xx.
      expect([401, 422], key(route)).toContain(res.status);
    }
  });
});

describe('role guards', () => {
  it('every admin route checks the admin sub-role (AdminGuard), not just the admin role', () => {
    const admin = mountedRoutes(app).filter((r) => r.path.startsWith('/admin/'));
    expect(admin.length).toBeGreaterThan(40);
    for (const route of admin) expect(route.handlers, key(route)).toContain(AdminPermissionMiddleware);
  });

  it('admin routes refuse every other role; provider routes refuse patients', async () => {
    const patient = await createUserWithToken(UserRole.PATIENT);
    const provider = await createUserWithToken(UserRole.PROVIDER);
    const routes = mountedRoutes(app).filter((r) => r.method === 'GET');
    const adminGets = routes.filter((r) => r.path.startsWith('/admin/'));
    const providerGets = routes.filter((r) => r.path.startsWith('/provider/'));
    expect(adminGets.length).toBeGreaterThan(15);
    expect(providerGets.length).toBeGreaterThan(5);

    for (const route of adminGets) {
      for (const user of [patient, provider]) {
        const res = await request(app)
          .get(prefix + sample(route.path))
          .set('Authorization', user.auth);
        expect([403, 422], `${key(route)} as ${user.user.role}`).toContain(res.status);
      }
    }
    for (const route of providerGets) {
      const res = await request(app)
        .get(prefix + sample(route.path))
        .set('Authorization', patient.auth);
      expect([403, 422], key(route)).toContain(res.status);
    }
  });
});

describe('no location data (spec §1)', () => {
  const LOCATION =
    /^(lat|lng|lon|long|latitude|longitude|location|locations|coords?|coordinates?|geo\w*|gps|distance\w*|geometry|position)$/i;

  it('the API has no location-like field, parameter or path segment', () => {
    const doc = buildOpenApiDocument();
    const found: string[] = [];
    const visit = (node: unknown, where: string) => {
      if (Array.isArray(node)) return node.forEach((n, i) => visit(n, `${where}[${i}]`));
      if (!node || typeof node !== 'object') return;
      for (const [k, v] of Object.entries(node)) {
        if (k === 'properties' && v && typeof v === 'object') {
          for (const name of Object.keys(v)) if (LOCATION.test(name)) found.push(`${where}.${name}`);
        }
        if (k === 'name' && typeof v === 'string' && LOCATION.test(v)) found.push(`${where} param ${v}`);
        visit(v, `${where}.${k}`);
      }
    };
    visit(doc, '$');
    for (const p of Object.keys(doc.paths ?? {})) {
      for (const segment of p.split('/')) if (LOCATION.test(segment.replace(/[{}]/g, ''))) found.push(p);
    }
    expect(found).toEqual([]);
  });

  it('no database schema stores location', async () => {
    // Load every model file so nothing is missed.
    const root = path.resolve(__dirname, '../../src/database/models');
    for (const file of fs.readdirSync(root, { recursive: true }) as string[]) {
      if (file.endsWith('.ts')) await import(path.join(root, file));
    }
    expect(mongoose.modelNames().length).toBeGreaterThan(25);

    const found: string[] = [];
    const scan = (schema: Schema, prefixPath: string) => {
      schema.eachPath((p, type) => {
        for (const part of p.split('.')) if (LOCATION.test(part)) found.push(`${prefixPath}${p}`);
        if (['2dsphere', '2d', 'geoHaystack'].includes(String((type.options as { index?: unknown }).index))) {
          found.push(`${prefixPath}${p} (geo index)`);
        }
        const nested = (type as unknown as { schema?: Schema }).schema;
        if (nested) scan(nested, `${prefixPath}${p}.`);
      });
      for (const [fields] of schema.indexes()) {
        if (Object.values(fields).some((v) => typeof v === 'string' && v.startsWith('2d'))) {
          found.push(`${prefixPath}geo index ${JSON.stringify(fields)}`);
        }
      }
    };
    for (const name of mongoose.modelNames()) scan(mongoose.model(name).schema, `${name}.`);
    expect(found).toEqual([]);
  });
});

describe('encryption at rest (spec §9)', () => {
  /** Medical data, identity numbers. Every entry must encrypt on write. */
  const ENCRYPTED: Record<string, string[]> = {
    PatientProfile: ['bloodType'],
    MedicalCondition: ['name', 'notes'],
    Medication: ['name', 'dosage', 'frequency', 'notes'],
    Allergy: ['name'],
    MedicalDocument: ['title'],
    VisitReport: ['summary', 'vitalsData', 'proceduresData', 'recommendations'],
    ProviderProfile: ['licenseNumber', 'syndicateNumber'],
    // Encrypt-on-write (read with .lean(); decrypted + audited where shown).
    Booking: ['patientNotes'],
    Dispute: ['description'],
    Message: ['body'],
    Conversation: ['lastMessage.body'],
    PayoutMethod: ['accountNumber'],
    Payout: ['destination'],
  };

  it.each(Object.entries(ENCRYPTED))('%s encrypts %j', (model, fields) => {
    const schema = mongoose.model(model).schema;
    for (const field of fields) {
      // applySetters exists at runtime but isn't in Mongoose's public typings.
      const type = schema.path(field) as unknown as { applySetters: (value: string, doc: object) => string };
      expect(type, `${model}.${field}`).toBeDefined();
      const stored = type.applySetters('سر طبي', {});
      expect(isEncrypted(stored), `${model}.${field}`).toBe(true);
      expect(decryptField(stored)).toBe('سر طبي');
    }
  });
});

describe('rate limits', () => {
  it('limits auth endpoints per IP (429 + Retry-After)', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 32; i++) {
      statuses.push((await request(app).post(`${prefix}/auth/refresh`).send({ refresh_token: 'x' })).status);
    }
    expect(statuses.slice(0, 30)).not.toContain(429);
    const blocked = await request(app).post(`${prefix}/auth/refresh`).send({ refresh_token: 'x' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(blocked.headers['retry-after']).toBe('60');
  });
});

describe('readiness', () => {
  it('reports MongoDB and Redis up', async () => {
    const res = await request(app).get(`${prefix}/health/ready`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ mongo: 'up', redis: 'up' });
  });
});

describe('scheduled job monitoring', () => {
  it('flags a job that stopped running, and clears once it runs again', async () => {
    const { jobHealth, recordHeartbeat } = await import('../../src/queues/heartbeat');
    const { runMaintenanceJob } = await import('../../src/queues/workers/maintenance.worker');
    const { MaintenanceJob } = await import('../../src/queues/queue-names');

    // Fresh deploy: nothing reported yet, nothing flagged yet.
    expect((await request(app).get(`${prefix}/health/jobs`)).status).toBe(200);

    // The deadline sweep last ran 10 minutes ago (limit: 3) → 503.
    for (const job of Object.values(MaintenanceJob)) await recordHeartbeat(job);
    await recordHeartbeat(MaintenanceJob.BOOKING_DEADLINES, new Date(Date.now() - 10 * 60_000));
    expect((await jobHealth()).find((j) => j.job === MaintenanceJob.BOOKING_DEADLINES)!.stale).toBe(true);
    const down = await request(app).get(`${prefix}/health/jobs`);
    expect(down.status).toBe(503);

    await runMaintenanceJob(MaintenanceJob.BOOKING_DEADLINES);
    const up = await request(app).get(`${prefix}/health/jobs`);
    expect(up.status).toBe(200);
    expect(up.body.data).toHaveLength(Object.values(MaintenanceJob).length);
  });

  it('a job that never starts is flagged once its allowance passes', async () => {
    const { jobHealth } = await import('../../src/queues/heartbeat');
    await jobHealth(new Date(Date.now() - 2 * 24 * 3600_000)); // first looked two days ago
    expect((await jobHealth()).every((j) => j.stale)).toBe(true);
  });
});
