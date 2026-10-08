# Security & privacy review (M1.9)

Results of the Phase 1 security pass against spec §9, and what is still open. Most controls are
enforced by tests, so they keep holding as the API grows — the test is named next to each one.

## Controls in place

| Area | Control | Enforced by |
|---|---|---|
| Authentication | Every route needs an access token + active account, except an explicit list of public routes (health checks, app config, lookups, consent texts, OTP / register / refresh / logout, payment webhooks and return). The account-deletion web page is public HTML that only calls those same API routes. The list and the OpenAPI `security` flags must agree. | `tests/integration/security.test.ts` — walks every mounted Express route |
| Authorization | Admin routes refuse patients and providers; provider routes refuse patients; patients reach only their own profiles, bookings and reports (404 otherwise). | `security.test.ts` (roles), `patient-profiles`, `bookings`, `aftercare` tests |
| Admin roles (M3.5) | Five admin roles (super admin, verifier, support, finance, marketing) from one permission table; a new admin route is super admin only until a rule allows more. Booking notes and dispute descriptions only for super admin and support. Every admin route runs the role check. | `tests/unit/admin-permissions.test.ts` (snapshot of the whole table), `security.test.ts`, `admin.test.ts` |
| Test numbers (launch) | Allowlisted numbers (`TEST_PHONE_NUMBERS`) sign in with a fixed code instead of an SMS; every issue and use is audited. In production the fixed code never opens a real account or an admin (an existing non-test account on that number gets a real SMS), and test accounts only find and book test providers / organizations — real patients never see them. Off while the list is empty. | `test-accounts.test.ts` |
| Consent (launch) | Terms, privacy and health-data consent texts are published as numbered versions (never edited); sign-up must accept the current ones for the role; every acceptance and withdrawal is an append-only record with time and IP. | `consent.test.ts` |
| Rate limits | Per IP in Redis (shared by instances): 300/min on all routes, 30/min on public auth routes; OTP SMS: 1/min + 3/10 min per phone, 10/hour per IP, 5 attempts per code; uploads 60/hour per user. | `security.test.ts`, `auth.test.ts`, `uploads.test.ts` |
| Location data | None anywhere: no location-like field, parameter or path in the API, and none (nor a geo index) in any database schema. Address bodies reject unknown fields by name. | `security.test.ts`, `addresses.test.ts` |
| Encryption at rest | AES-256-GCM per field: blood type, conditions, medications, allergies, medical document titles, visit reports (summary, vitals, procedures, recommendations), booking notes, dispute descriptions, license and syndicate numbers. Booking notes and dispute descriptions are decrypted only where shown (assigned provider after acceptance, admins), and each view is audited. | `security.test.ts` (every listed field), `field-encryption.test.ts` |
| Files | Private bucket; only 10-minute signed URLs; file type detected from bytes; uploads promoted only by their owner for the declared purpose. | `uploads.test.ts`, `storage.test.ts` |
| Medical access | Providers see the medical summary only during the visit and 7 days after; patient phone, address and notes hidden while a booking is pending. | `bookings.test.ts` |
| Audit | Every admin write and every medical read/write is audited; entries never contain medical values; the log is append-only. | `database.test.ts` (append-only), `admin`, `aftercare`, `patient-profiles` tests |
| Sessions | Access JWT 1 h (HS256 pinned); refresh tokens hashed and rotated; reuse revokes the session; suspension/deletion blocks on the next request. | `auth.test.ts`, `admin.test.ts` |
| Errors & logs | Error envelope without stack traces; Sentry automatic data collection off; request ids on every log line. | `http-contract.test.ts` |
| Dependencies | `npm audit --omit=dev` clean; CI fails on moderate or worse. (Test-only `ioredis-mock` has a known advisory in a transitive dependency; not shipped.) | CI |

## Open items

1. **Legal review (Law 151/2020)** not started: data retention periods, account-deletion retention,
   consent wording, data-processing agreements with the SMS / storage / push providers. The questions are in the data inventory (`docs/DATA_INVENTORY.md`).
2. **SMS provider** still TBD (spec §12.1) — OTP can't go to production until it's chosen.
3. ~~Admin sub-roles~~ — done in M3.5 (see the table above).
4. **HTTPS** is terminated at the load balancer / proxy (Caddy in `deploy/`, automatic certificates, HSTS). Make sure plain HTTP is redirected there.
5. **Backups** contain names, phones and addresses in plain text — store them encrypted (see `docs/OPERATIONS.md`).
6. **Test numbers in production**: keep the list to the app-store reviewer numbers, use a code that can't be guessed, and empty the list after review if the stores allow it.
7. **Independent penetration test** of staging before launch (recommended for health data).
