# Security & privacy review (M1.9)

Results of the Phase 1 security pass against spec §9, and what is still open. Most controls are
enforced by tests, so they keep holding as the API grows — the test is named next to each one.

## Controls in place

| Area | Control | Enforced by |
|---|---|---|
| Authentication | Every route needs an access token + active account, except an explicit list of 16 public routes (health checks, app config, lookups, OTP / register / refresh / logout). The list and the OpenAPI `security` flags must agree. | `tests/integration/security.test.ts` — walks every mounted Express route |
| Authorization | Admin routes refuse patients and providers; provider routes refuse patients; patients reach only their own profiles, bookings and reports (404 otherwise). | `security.test.ts` (roles), `patient-profiles`, `bookings`, `aftercare` tests |
| Rate limits | Per IP in Redis (shared by instances): 300/min on all routes, 30/min on public auth routes; OTP SMS: 1/min + 3/10 min per phone, 10/hour per IP, 5 attempts per code; uploads 60/hour per user. | `security.test.ts`, `auth.test.ts`, `uploads.test.ts` |
| Location data | None anywhere: no location-like field, parameter or path in the API, and none (nor a geo index) in any database schema. Address bodies reject unknown fields by name. | `security.test.ts`, `addresses.test.ts` |
| Encryption at rest | AES-256-GCM per field: blood type, conditions, medications, allergies, medical document titles, visit reports (summary, vitals, procedures, recommendations), license and syndicate numbers. | `security.test.ts` (every listed field), `field-encryption.test.ts` |
| Files | Private bucket; only 10-minute signed URLs; file type detected from bytes; uploads promoted only by their owner for the declared purpose. | `uploads.test.ts`, `storage.test.ts` |
| Medical access | Providers see the medical summary only during the visit and 7 days after; patient phone, address and notes hidden while a booking is pending. | `bookings.test.ts` |
| Audit | Every admin write and every medical read/write is audited; entries never contain medical values; the log is append-only. | `database.test.ts` (append-only), `admin`, `aftercare`, `patient-profiles` tests |
| Sessions | Access JWT 1 h (HS256 pinned); refresh tokens hashed and rotated; reuse revokes the session; suspension/deletion blocks on the next request. | `auth.test.ts`, `admin.test.ts` |
| Errors & logs | Error envelope without stack traces; Sentry automatic data collection off; request ids on every log line. | `http-contract.test.ts` |
| Dependencies | `npm audit --omit=dev` clean; CI fails on moderate or worse. (Test-only `ioredis-mock` has a known advisory in a transitive dependency; not shipped.) | CI |

## Open items

1. **Free text that may contain health details is not encrypted**: booking `patient_notes`
   ("المريض لا يستطيع الحركة") and dispute `description`. Both are access-controlled (participants /
   admins only) but stored in plain text. Decide with the legal review whether they count as medical data;
   encrypting them means reading bookings through hydrated documents instead of `.lean()` in several places.
2. **Legal review (Law 151/2020)** not started: data retention periods, account-deletion retention,
   consent wording, data-processing agreements with the SMS / storage / push providers.
3. **SMS provider** still TBD (spec §12.1) — OTP can't go to production until it's chosen.
4. **Admin sub-roles** (super_admin / verifier / support / finance) are TBD; today every admin can do everything (all audited).
5. **HTTPS** is terminated at the load balancer / proxy (not in the app); HSTS comes from helmet. Make sure plain HTTP is redirected there.
6. **Backups** contain names, phones and addresses in plain text — store them encrypted (see `docs/OPERATIONS.md`).
