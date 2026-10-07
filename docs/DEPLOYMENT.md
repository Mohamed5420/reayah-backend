# Deployment

How to put the Reaya+ API on a server, what is needed to start, and where to host it. Day-to-day
operations (alerts, backups, load test) are in `docs/OPERATIONS.md`.

## What's ready

| Piece | File | What it does |
|---|---|---|
| Image | `Dockerfile` | Node 22, production dependencies only, runs as a non-root user, health check on `/api/v1/health/ready` |
| Server stack | `deploy/docker-compose.yml` + `deploy/Caddyfile` | API behind Caddy (automatic HTTPS, WebSockets). `--profile self-hosted` adds MongoDB (authenticated replica set), Redis (password) and MinIO on the same server; without it, point the URIs at managed services |
| Environment template | `deploy/env.example` | Every variable, with how to generate secrets |
| Backups | `deploy/backup.sh`, `ops/mongo-restore-drill.sh` | Nightly dump (cron) + restore drill |
| CI | `.github/workflows/ci.yml` | Tests, lint, audit, and a Docker build check on every push |
| CD | `.github/workflows/deploy.yml` | `main` → image → staging; tag `v*` → backup → production (after approval); smoke test on `/health/ready`. Skips itself until a server is configured |

Not yet verified: the image has not been built on this machine (no Docker here); the first CI run builds it.
The CD workflow expects the default branch to be `main` (the local repo is on `master`: `git branch -m master main`).

## Hosting recommendation

**Host in Egypt unless counsel confirms a cross-border transfer licence is worth getting.**

- Egypt's PDPL executive regulations (Ministerial Decision 816/2025, issued 1 Nov 2025) require a licence
  for transfers of personal data outside Egypt, *including to cloud environments*, and compliance is expected
  from 1 Nov 2026 ([CMS](https://cms.law/en/are/legal-updates/egypt-s-pdpl-executive-regulations-issued-one-year-compliance-countdown-begins)).
  Health data adds written-consent requirements. Hosting abroad is possible but means a licence application
  (90-working-day review) and a transfer impact assessment.
- Huawei Cloud has run a public cloud region in Cairo since May 2024
  ([Huawei](https://www.huaweicloud.com/intl/en-us/news/20240523155312706.html)); AWS, Google and Oracle serve
  Egypt from regions abroad ([overview](https://momentumx.cloud/egypt-cloud-providers-2026/)). Local
  data-centre operators (e.g. Etisalat/e&, Telecom Egypt) offer VMs too.
- The stack is plain Docker, so it runs the same on any provider's VMs. That keeps the choice reversible.

| Option | For | Against |
|---|---|---|
| **A. Huawei Cloud Cairo (VMs + its S3-compatible object storage), MongoDB self-hosted in the stack** — *recommended* | Data stays in Egypt; low latency; managed object storage and backups | Smaller ecosystem; we run MongoDB ourselves (a managed MongoDB-compatible service is fine only if it supports multi-document transactions — must be checked) |
| B. Egyptian data-centre VMs (local operator) | Data in Egypt; local billing and support | Fewer managed services; more operations work for us |
| C. AWS UAE / Bahrain or Europe + MongoDB Atlas | Mature managed services (MongoDB Atlas dedicated clusters from roughly $57/month for M10 — approximate, check [MongoDB pricing](https://www.mongodb.com/pricing)) | Needs the cross-border licence first |

Push notifications (Google FCM), the SMS provider and Sentry are outside Egypt whichever option is picked;
they carry no health data, but counsel should confirm they need no licence (listed in the data inventory).

## Budget (rough — replace with real quotes)

| Item | Staging | Production (launch size) |
|---|---|---|
| Servers | 1 VM, 2 vCPU / 4–8 GB, all-in-one profile | 2 API VMs (2 vCPU / 4 GB) + 3 MongoDB VMs (2 vCPU / 8 GB, replica set) or a managed database, + load balancer |
| Storage, backups, traffic | small | object storage + backup copies in a second location |
| Estimated monthly | **~$50–100** | **~$300–700** |
| SMS (sign-in codes) | — | per message, from the chosen provider; ~2 messages per sign-in |
| Domain | ~$15 / year | (same domain) |
| Sentry | free tier | free or team plan |

The load test (`docs/OPERATIONS.md`) shows one API process handling ~150 searches/s, so two small API
servers cover launch traffic with room for failover; scale by adding API servers.

## What I need from you

1. **Hosting decision** (after counsel's answer on cross-border transfers) and an account there with billing — invite me / the DevOps person with admin rights.
2. **Domain**: the domain name and access to its DNS (to add `api.` and `api-staging.` records).
3. **SMS provider**: the chosen company, an account, API credentials and an approved sender name ("Reaya" / "رعاية"). Needed for production sign-in; staging works without it.
4. **Firebase**: the project used by the mobile apps → a service account JSON (Project settings → Service accounts).
5. **GitHub**: the repository on GitHub with Actions enabled, and the default branch named `main`.
6. **Sentry** (optional): an organization and project → its DSN.
7. **Admin accounts**: names and mobile numbers of the first admins.
8. **Budget approval** for the monthly estimate above.

I generate the rest myself (JWT secret, encryption key, database and Redis passwords) and store them in the
host's secret manager or your password manager — the encryption key needs a copy outside the server.

## First deployment (once a server exists)

1. Server: Ubuntu LTS, Docker Engine + Compose plugin, a `deploy` user in the `docker` group, ports 80/443 open only.
2. `git clone` (or copy `deploy/`) to `/opt/reaya`; `cp deploy/env.example deploy/.env`; fill it in; Firebase JSON into `deploy/secrets/firebase.json`.
3. DNS: `api-staging.<domain>` → the server's IP.
4. `cd /opt/reaya/deploy && docker compose --profile self-hosted up -d`; check `https://api-staging.<domain>/api/v1/health/ready`.
5. Admin: `docker compose exec api node dist/scripts/create-admin.js --phone +20… --name "…"`.
   Staging data: `docker compose exec api node dist/scripts/seed-staging.js`.
6. GitHub: set the variables and secrets listed at the top of `.github/workflows/deploy.yml`; from then on, every push to `main` deploys staging.
7. Then, from `docs/OPERATIONS.md`: cron the nightly backup, run the restore drill, wire the alerts, re-run the load test against staging.
