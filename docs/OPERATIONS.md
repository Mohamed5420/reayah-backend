# Operations runbook

For whoever deploys and runs the Reaya+ API (staging and production). Development setup is in
`README.md` / `CLAUDE.md`.

## Runtime

- **Node 22 LTS** (`.nvmrc`). Node 24.15 crashes natively on Windows under the test suite; production
  should run the same major version as CI.
- **MongoDB replica set** (transactions are required — booking races depend on them).
- **Redis** — cache, rate limits, idempotency keys, BullMQ queues, job heartbeats. Shared by every instance.
- **S3-compatible private bucket** for uploads (signed URLs, 10 minutes).
- **Firebase** service account for push (optional; without it pushes are skipped, in-app + socket still work).

Every instance runs the HTTP API, Socket.IO and the BullMQ workers; scheduled jobs are BullMQ job
schedulers, so running several instances never duplicates them.

### Environment

Copy `.env.example`. Must be set per environment (never shared between staging and production):

| Variable | Notes |
|---|---|
| `MONGO_URI`, `REDIS_*` | |
| `JWT_SECRET` | long random string; rotating it logs everyone out |
| `FIELD_ENCRYPTION_KEY` | base64 32-byte key. **Losing it makes encrypted medical/identity data unreadable — including in backups.** Keep it in the secret manager, backed up separately from the database. Never change it without a re-encryption migration. |
| `S3_*` | private bucket |
| `FIREBASE_SERVICE_ACCOUNT_PATH` | file outside the repo |
| `SMS_DRIVER` | `log` refuses to run in production; the real SMS provider is still TBD (spec §12.1) |
| `SENTRY_DSN` | error tracking (automatic data collection is off — medical data) |
| `CORS_ORIGINS` | comma-separated; don't leave `*` in production |
| `RATE_LIMIT_PER_MINUTE` / `RATE_LIMIT_AUTH_PER_MINUTE` | per IP, defaults 300 / 30. Behind a proxy, `trust proxy` is 1 hop — adjust if there are more. |
| `BULL_BOARD_PASSWORD` | enables `/admin/queues` (basic auth); leave empty to disable |

## Health checks & alerts

| Check | Use | Alert when |
|---|---|---|
| `GET /api/v1/health` | liveness (process up) | — |
| `GET /api/v1/health/ready` | load balancer readiness; 503 when MongoDB or Redis doesn't answer in 2 s | 503 for > 1 min |
| `GET /api/v1/health/jobs` | 503 when a scheduled job has gone silent (deadline sweep > 3 min, reminders > 5 min, suspension lifts > 20 min, presence > 3 h, document check > 26 h) | any 503 — bookings stop expiring / reminders stop going out |
| Sentry | unhandled errors | new issue, or error rate spike |
| Logs (JSON, `requestId` on every line) | `Readiness check failed`, `Scheduled jobs silent`, `Rate limiter … unavailable`, `FCM failed` | sustained occurrences |
| Bull Board `/admin/queues` | failed jobs in `notifications` / `maintenance` | failed count growing |

Suggested latency alert: p95 of read endpoints > 300 ms for 10 min (spec §10).

## Backups

- Take a backup at least daily, plus before every deploy that migrates data:
  `MONGO_URI=… ./ops/mongo-backup.sh /backups` (mongodump `--oplog` → consistent replica-set snapshot).
  A managed MongoDB's own point-in-time backups are an equally good alternative.
- Dumps contain medical data (encrypted fields stay encrypted, but names/phones/addresses don't):
  store them encrypted, access-controlled, in another region. Retention: per the data-retention policy (spec §9, TBD with legal).
- **Restore drill** — monthly and before launch, against a scratch database, never the live one:
  `SOURCE_URI=… TARGET_URI=… ./ops/mongo-restore-drill.sh /backups/reaya-….archive.gz`.
  It restores, then compares per-collection document counts. Record the date, duration and result.
- To actually restore production: stop the API instances, `mongorestore --drop --oplogReplay` into the
  live database, start the API, check `/health/ready` and `/health/jobs`, then spot-check a patient
  profile (encrypted fields decrypt only with the same `FIELD_ENCRYPTION_KEY`).

## Staging data

`npm run seed:staging -- --providers 200 --patients 50 --bookings 40` (refuses `NODE_ENV=production`;
safe to re-run). Demo patients use `+20100000NNNN`, providers `+20110000NNNN`; with `SMS_DRIVER=log`
the OTP appears in the server log. Create an admin with `npm run admin:create`.

## Load test

`npm run test:load` seeds 1,000 providers into an in-memory database and drives the real app over HTTP
(`LOAD_PROVIDERS`, `LOAD_CONCURRENCY`, `LOAD_REQUESTS` to change the size). It fails if any read
endpoint's p95 reaches 300 ms or if concurrent bookings double-book a provider.

Local result (2026-10-07, one process on a dev laptop, MongoDB in-process, 1,000 providers):

| Scenario | p95 @ 10 clients | p95 @ 20 clients | req/s |
|---|---|---|---|
| `GET /home` | 50 ms | 152 ms | ~260 |
| `GET /providers` (area + service) | 77 ms | 153 ms | ~155 |
| `GET /providers` (+ date + time) | 82 ms | 158 ms | ~145 |
| `GET /providers/{id}` | 52 ms | 108 ms | ~220 |
| `GET /providers/{id}/slots` | 41 ms | 82 ms | ~275 |
| `GET /bookings` | 40 ms | 71 ms | ~300 |
| quote + book (contested slot) | 95 ms | 442 ms | ~115 |

Repeat on staging (real MongoDB on its own machine) before launch, and size the number of instances
from the req/s per process.

## Deploy checklist

1. CI green on the commit (typecheck, lint, format, tests, build, `npm audit --omit=dev`).
2. Backup taken (see above).
3. Deploy; new instances must pass `/health/ready` before taking traffic.
4. After deploy: `/health/jobs` 200 within 5 minutes; no new Sentry issues; spot-check login + search.
