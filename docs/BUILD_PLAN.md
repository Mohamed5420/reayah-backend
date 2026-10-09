# Reaya+ Backend — Build Plan

Phased plan for implementing [Reaya_Backend_Spec.md](./Reaya_Backend_Spec.md) (v2.2) on top of the existing `reayah-backend` scaffold.
Section references like **§6.10** point into the spec.

Phases follow the spec's delivery phases (§11), with a **Phase 0** added to bring the scaffold in line with the spec's API contract. Each phase is split into milestones. A milestone is done when its **exit criteria** pass, not when the code is written.

---

## Stack decision: keep the existing scaffold

The spec lists NestJS/Laravel + PostgreSQL as *suggestions*. This repo already has **Express + TypeScript + MongoDB (Mongoose) + Redis/BullMQ + Socket.IO + TypeDI + FCM**, which covers what the spec needs. The plan keeps that stack. What that means in practice:

| Spec assumption | How we do it on MongoDB |
|---|---|
| "tables" / joins | Collections; embed small owned lists (e.g. provider service areas, availability) and reference everything else. |
| UUID ids | Expose ObjectId strings. The clients treat ids as opaque strings, so the contract stays the same. |
| Row lock for "first to accept wins" (§6.6) | Atomic conditional update: `findOneAndUpdate({ _id, status: 'pending' }, …)`. No match → `409 OFFER_TAKEN`. |
| Transaction for double-booking (§6.2) | Mongo transactions (**needs a replica set, also in local dev**) + a short Redis lock per provider while checking for overlapping bookings. |
| `NUMERIC` money | Integer piastres in `Number` fields. Never floats, never `Decimal128`. |
| Soft delete on all tables | `deletedAt` field + a shared Mongoose plugin that filters it out by default. |
| Encrypted columns (§9) | Field-level encryption (app-side AES-GCM helper) for medical data, national ID and license numbers. |

---

## Decisions needed before (and during) the build

From spec §12. Each one blocks the milestone listed next to it. Until a decision is made, build with the **default** so work isn't held up.

| # | Question | Blocks | Default to build with |
|---|---|---|---|
| 1 | SMS/OTP provider | M1.2 | Fake SMS driver (logs the code), behind an `SmsProvider` interface |
| 1 | Payment gateway | M2.3 | — (Phase 2) |
| 2 | Phone reveal vs masked numbers | M1.6 | Reveal after `accepted` |
| 3 | Cancellation / refund policy | M1.6 | Free cancel up to `cancellation_free_window_hours` (3); after that → `CANCELLATION_NOT_ALLOWED` |
| 4 | Provider access window to medical data | M1.6 | Active bookings + 7 days after completion |
| 5 | One phone, multiple roles? | M1.2 | No — one role per account |
| 6 | Admin min/max price per service | M1.4 | Optional `minPrice`/`maxPrice` fields; enforced only if set |
| 7 | Package visit decremented on accept or complete | M2.5 | On completion |
| 8 | Realtime: Socket.IO or Firebase | M1.7 | Socket.IO (already in the scaffold) |
| 9 | Data retention after deletion | M1.2 | Anonymise PII after 30 days, keep financial records |
| 10 | Commission on travel fee? | M1.6 | No — travel fee goes 100% to the provider/org |
| 11 | Preferred gender strict or soft | M1.5 | Strict filter |
| 12 | Patient consent for fallback | M1.6 / M3.3 | `allow_fallback` checkbox, default on |
| 13 | Is 3 minutes enough for direct requests? | M1.6 | Keep it as a setting (default 3) |
| 14 | Expired license auto-pauses provider? | M1.8 | Yes — set `is_accepting_bookings = false` + notify |

---

## Phase 0 — Foundation (align the scaffold with the spec)

The scaffold works, but its contract differs from the spec in several places. Fix these first, before any domain endpoint is built on top of them.

### M0.1 API contract & errors
- [x] Success envelope `{ data, meta }` instead of `{ success, message, data }` (§7.0). Update `HttpResponse`.
- [x] Pagination: `page` / `per_page` (max 100) → `meta: { page, per_page, total, last_page }`. Add a shared `parsePagination(req)` helper.
- [x] Error envelope `{ error: { code, message, fields } }`. Every `HttpError` gets a machine `code` from the global error-code list (§7.0); add domain error classes (`SlotUnavailableError`, `OfferTakenError`, `InvalidStatusTransitionError`, …).
- [x] Validation failures → `422 VALIDATION_ERROR` with `fields` grouped per input (the scaffold currently returns 400).
- [x] Express-validator output mapped to `fields`.

### M0.2 i18n (Arabic only, i18n-ready)
- [x] Replace `bilingualMessage('en','ar')` with translation files (`locales/ar.json`, `locales/en.json` empty for now) keyed by error code / notification type, and a `t(key, params)` helper.
- [x] Language comes from `Accept-Language`, falling back to `user.language`, then `ar`. (`user.language` is read from `req.user`; it gets filled once M1.2 stores it.)

### M0.3 Cross-cutting infrastructure
- [x] **Settings service**: `settings` collection + typed getters with defaults (commission rate, `org_assign_deadline_minutes`=25, `fallback_window_minutes`=20, `direct_request_response_minutes`=3, `on_time_grace_minutes`=15, `cancellation_free_window_hours`=3, `referral_reward`=5000, `payout_day`=thursday, feature flags). Cache in Redis and drop the cache on update.
- [x] **Audit log**: `audit_logs` model + `AuditService.log(actor, action, entity, metadata, ip)`.
- [x] **Idempotency middleware** (`Idempotency-Key`, stored in Redis with the response, 24h TTL) for the routes listed in §7.0.
- [x] **Soft-delete plugin** + shared `timestamps`.
- [x] **Field encryption helper** (§9) with key from env.
- [x] **File storage**: S3-compatible client, private bucket, `StorageService.putTemp / promote / signedUrl(10 min)`. Add the env vars to `env.config.ts`.
- [x] Mongo runs as a **replica set** in dev (docker-compose for Mongo RS + Redis + MinIO). *Written but not yet run — no Docker on the machine it was built on.*

### M0.4 Tooling
- [x] Install and configure ESLint (`npm run lint` currently fails — no ESLint installed).
- [x] Test runner (Vitest or Jest) + `mongodb-memory-server` (replica-set mode) + supertest. Scripts for the full suite and for a single file.
- [x] OpenAPI/Swagger generation (§3) — e.g. `zod` / `express-validator` schemas → OpenAPI, served at `/docs` outside production. *(Validation moved to zod; `defineRoute()` drives both.)*
- [x] Sentry (or equivalent) error tracking; structured winston logs with a request id.
- [x] CI: typecheck + lint + tests on every push. *(Workflow written; the repo has no GitHub remote yet, so it hasn't run on GitHub.)*

**Exit criteria:** health endpoint returns the new envelope; a sample endpoint shows `422` with `fields`; tests and lint run green in CI; staging deploy works against a Mongo replica set.

---

## Phase 1 — MVP (nursing only)

Goal: a patient can book a verified nurse for a home visit in a covered area, pay cash, follow the status, and rate the visit. An admin verifies nurses and runs the catalog.

### M1.1 Locations & catalog (§4.2, §4.5, §7.3)
- [x] Models: `governorates`, `areas` (`isActive`, `maxTravelFee`), `service_categories`, `services` (`nameAr` required, `nameEn` nullable, `pricingUnit`, `defaultDurationMinutes`, optional min/max price).
- [x] Seed: Cairo, Giza, Alexandria + their areas; nursing category + starter services. *(48 areas, 9 nursing services; other categories seeded inactive.)*
- [x] Public lookups: `/governorates`, `/governorates/{id}/areas`, `/areas?search=`, `/service-categories`, `/services`, `/services/{id}`, `/app-config`. Cache headers + Redis cache.
- [x] Admin catalog & location CRUD (§7.15 "Catalog & locations"). *(Behind the scaffold's admin role + `catalog_manage` permission until M1.2 replaces auth.)*
- [ ] Follow-up for M1.4/M1.5: `starting_price` on `/services` is `null` until provider prices exist. Enforce the area `maxTravelFee` cap and service min/max price bounds when providers set their fees and prices.

**Exit:** the mobile app can fill every picker from the API; the admin can activate/deactivate an area.

### M1.2 Auth & accounts (§4.1, §7.1, §7.2)
- [x] Replace the scaffold's email/password `User` with the spec's user: `phone` (E.164, unique), `fullName`, `gender`, `dateOfBirth`, `role` (patient | provider | provider_staff | owner | admin), `language`, `status`, `lastLoginAt`. *(Egyptian mobiles only at launch.)*
- [x] `otp_codes` (hashed code, expiry, attempts) + `SmsProvider` interface (fake driver in dev).
- [x] OTP rate limits in Redis: 3 per phone / 10 min, 10 per IP / hour; `OTP_INVALID | OTP_EXPIRED | OTP_MAX_ATTEMPTS`. *(Plus the spec's 60 s resend wait.)*
- [x] Tokens: short-lived access JWT, rotating refresh tokens (stored hashed, revocable), registration token for new users.
- [x] `/auth/otp/request`, `/auth/otp/verify`, `/auth/register` (with side effects: patient → `self` profile; provider → draft `provider_profile`), `/auth/refresh`, `/auth/logout`, phone change.
- [x] `/me` endpoints, `devices` (FCM tokens), account deletion request (blocked with active bookings). *(GET/PATCH/DELETE /me + devices. Deferred: `POST /me/avatar` → M1.3 with uploads; `GET /me/referral` → M2.5; the "active bookings" block → M1.6; the 30-day anonymisation job → M1.9.)*
- [x] Role guard middleware (`RequireRole('patient')`), replacing the scaffold's `UserRole.USER`. `IsBlocked` becomes a check on `status` / active suspension → `ACCOUNT_SUSPENDED`. *(`Auth(...roles)`; timed suspensions arrive with `user_suspensions` in M1.8.)*
- [x] Socket auth switched to the new access token.
- [x] Admin accounts: `npm run admin:create` (admins can't self-register). Scaffold `/users` endpoints removed; admin user management is M1.8.
- [ ] Before launch: plug in the real SMS provider (spec §12.1) — `SMS_DRIVER=log` refuses to send in production.

**Exit:** a new phone number can register as patient or provider, refresh tokens, and log out; rate limits are covered by tests.

### M1.3 Patient profiles, medical records & addresses (§4.2, §4.3, §7.5, §7.6, §7.4)
- [x] `addresses` (text only — **reject any coordinate fields**), default address handling, delete blocked by upcoming bookings. *(Strict body: unknown fields → 422 by name. The "upcoming bookings" block → M1.6.)*
- [x] `patient_profiles` + conditions, medications, allergies, medical documents (encrypted medical fields).
- [x] `POST /uploads` (10 MB, jpg/png/pdf, `purpose`) → temp key; attach endpoints promote the file. *(Type detected from file bytes; 60 uploads/hour/user. Also `POST /me/avatar`, deferred from M1.2.)*
- [x] Ownership checks: a patient only reaches their own profiles. Reading medical data writes an audit log entry. *(Writes too; entries never contain the medical values.)*
- [x] Moved to M1.8 (needs visit reports): `GET /patient-profiles/{id}/visit-reports` and `/{rid}`; `visit_reports_count`. *(Done in M1.8.)*

**Exit:** a patient manages self + family profiles with a full medical summary and uploaded documents.

### M1.4 Provider onboarding & admin verification (§4.4, §7.10 onboarding, §7.15 verification)
- [x] `provider_profiles` with the full `verification_status` flow (draft → pending → changes_requested / approved / rejected / suspended). *(`suspended` is set by admin provider management in M1.8.)*
- [x] `provider_documents` with per-document status and `expiresAt`.
- [x] Coverage: service areas with `travelFee` (rejected if above the area's `maxTravelFee`), services & prices (within min/max if set), weekly availability, time off, accepting toggle (`PROVIDER_NOT_VERIFIED`). *(Areas/services/availability embedded in the profile; organization staff can't set areas or prices.)*
- [x] Onboarding checklist in `GET /provider/profile`; `submit-verification` only when `can_submit`. *(422 names each missing item.)*
- [x] Admin: verification queue, details with signed document URLs, approve / request-changes / reject, single-document review. All admin writes audited.
- [x] M1.1 follow-ups: `/services` `starting_price` now real (lowest price among approved, accepting providers); travel-fee cap and price bounds enforced.
- [ ] Notification `verification_result` → M1.7 (marked `TODO(M1.7)` in `VerificationService`).
- [ ] For M1.6: when an admin later lowers an area's cap or a service's bounds, existing provider fees/prices aren't rewritten — the quote must clamp the travel fee to the current cap and reject out-of-bounds prices.

**Exit:** a nurse completes onboarding, an admin approves them, and they can switch on accepting bookings.

### M1.5 Discovery & slots (§6.1, §6.11, §7.7)
- [x] Availability engine: weekly slots − time off − existing bookings → free slots for a service duration × quantity. All UTC internally; day boundaries computed in `Africa/Cairo`. *(DST-aware. Bookings are added to `DiscoveryService.busyIntervals` in M1.6. Rules: 30-min steps, ≥ 60 min lead, ≤ 60 days ahead; per-day = one slot per window.)*
- [x] `GET /providers` — matching by **area only** (§1), verified + accepting, offers the service, preferred gender filter, price/rating/type/source filters, sorts. Add indexes for the main filter path.
- [x] `GET /providers/{id}`, `/reviews`, `/slots`. *(`/reviews` and `recent_reviews` are empty until M1.8.)*
- [x] `GET /home` (upcoming booking, categories; banners and packages return empty until Phase 2). *(`upcoming_booking` filled in M1.6.)*
- [x] Performance: local benchmark, 2,000 providers / 48 areas, through the full app — p95 35 ms plain, 74 ms with date + time filter. Re-check on staging once it exists.
- [ ] Open question for the product team: travel buffer between back-to-back home visits (slots don't add one yet).

**Exit:** search returns only eligible nurses for an area/service/date; p95 under 300 ms on seeded staging data (§10).

### M1.6 Booking core (§4.6, §5, §6.2–6.3, §6.9a–6.13, §7.8, §7.10 bookings)
- [x] **Pricing engine** (server-side only): `price × quantity + travel_fee − discount + platform_fee`. `POST /bookings/quote` returns lines + a signed `quote_token` valid for 10 min. *(Travel fee clamped to the area's current cap; out-of-bounds provider prices refused.)*
- [x] `POST /bookings` (Idempotency-Key): re-validates the quote, slot and area, snapshots address + price, creates a `reference_code` (`RY-XXXXXX`), cash only.
- [x] **State machine** module: a single transition table, every change written to `booking_status_history`, emits a socket event + push. Invalid change → `409 INVALID_STATUS_TRANSITION`. Video skips `on_the_way`. *(Events go through `bookingEvents`; sockets subscribe now, push subscribes in M1.7.)*
- [x] Double-booking protection on accept (transaction + per-provider Redis lock). *(Changed: no Redis lock — each booking transaction bumps the provider's `scheduleVersion`, so concurrent ones conflict and the retry sees the winner. Mutation-tested: without it, both race tests fail.)*
- [x] Provider actions: accept, decline, on-the-way, start (sets `isOnTime` using `on_time_grace_minutes`), complete, no-show, cancel, cash-collected.
- [x] Patient actions: list (upcoming/past), details with timeline and `can_*` flags, cancel (free-window rule), reschedule (back to `pending`). *(Plus rebook. Review / dispute → M1.8.)*
- [x] **Privacy gating**: patient phone, full address and medical summary hidden from the provider while `pending`; medical access limited by the access window decision. *(Active visit + 7 days after completion; reads audited.)*
- [x] **Direct-request timeout + fallback broadcast** (§6.9a, §6.10): BullMQ delayed job at `direct_request_response_minutes` → creates `booking_offers` for other eligible independent providers in the area (respecting preferred gender and `allow_fallback`) → `fallback_window_minutes` later, if nobody accepted → `expired`. `/provider/offers` + atomic accept (`OFFER_TAKEN`), other offers → `lost`. *(Changed: a 30-second sweep instead of per-booking delayed jobs. Fallback providers are offered the price the patient accepted.)*
- [x] On completion: ledger entries for cash bookings (commission as `commission_due` debit, §4.8) so earnings data exists before Phase 2 exposes it.
- [x] Earlier follow-ups: busy time includes bookings; address and account deletion blocked by active bookings; `/home` shows the next booking.
- [ ] Open question for the product team: should a provider's explicit **decline** also trigger the fallback broadcast (today only an unanswered request does)?
- [x] Known issue (local Windows only): the test process sometimes crashed natively (`0xC0000409`). *(Specific to Node 24.15: 3/10 runs crashed vs 0/10 on Node 22.23 LTS, which CI uses. `.nvmrc` pins 22.)*

**Exit:** end-to-end booking on staging: quote → book → accept → on the way → start → complete. A concurrency test shows two providers accepting the same offer gives exactly one winner, and a provider can't be double-booked.

### M1.7 Notifications & realtime (§7.12 WebSocket part, §7.13, §8)
- [x] `notifications` model + `NotificationService.send(user, type, data)` → in-app record + FCM push (via the existing BullMQ notifications queue) + socket `notification.new`. Texts come from `ar.json`. *(`notify()`; booking notifications subscribe to `bookingEvents`. Dead FCM tokens are pruned. Opt-outs silence push only.)*
- [x] Socket rooms `user.{id}` and `booking.{id}`; join rules (only participants). Events: `booking.status_changed`, `booking.new_request`. *(Plus `booking.offer_taken`; `booking:subscribe` with ack.)*
- [x] Reminder jobs 24 h and 1 h before a visit (scheduled on accept, removed on cancel/reschedule). *(Changed: a 1-minute sweep with claim-once flags on the booking; reschedule resets them.)*
- [x] `/notifications`, mark read, notification settings. *(`/me` `unread_notifications` is now real.)*
- [x] M1.4 follow-up: `verification_result` notification on approve / request changes / reject.
- [x] `review_request` on completion (M1.8 — replaces `booking_completed`).
- [ ] Later: `assignment_deadline_warning` (organizations, Phase 3); chat / payout / package / promo types (Phase 2).
- [ ] Before launch: set `FIREBASE_SERVICE_ACCOUNT_PATH` — without it pushes are skipped (in-app + socket still work).

**Exit:** each status change in M1.6 reaches the other party by push and socket within a few seconds.

### M1.8 Visit reports, reviews & basic admin (§4.6, §6.8, §7.15)
- [x] Visit report submit/edit (24 h edit window), linked to the patient profile; patient reads it under `/patient-profiles/{id}/visit-reports`. *(From `in_progress` on; summary, vitals and procedures encrypted; patient reads audited; patient notified (`visit_report`); `visit_report_id` on booking details, `visit_reports_count` on the profile.)*
- [x] Reviews: only after `completed`, one per booking (`ALREADY_REVIEWED`, also on a double-submit race). *(Changed: rating recalculated right away from visible reviews instead of a background job — cheap and never stale. Comments with phone numbers (incl. Arabic-Indic digits), emails or links are flagged for moderation. Public reviewer name = first name + initial. `can_review` on booking details; `/providers/{id}/reviews`, `recent_reviews`, `/provider/reviews` are real.)*
- [x] Disputes: patient opens one within the allowed window; admin resolve (refund parts become active in Phase 2). *(Window = setting `dispute_window_hours` (48) after completion or a recorded no-show; booking → `disputed`. Full refund defaults to the booking total; amounts recorded only. Resolve can warn / suspend the provider and messages each side. Attachments use a new upload purpose `dispute`, not in spec §7.4.)*
- [x] Admin basics: dashboard KPIs, users list/details, suspend (timed, cancels future bookings) / warn / activate / history, bookings list + details + force status + reassign, reviews moderation (hide, mask contact), settings, audit log viewer, admin accounts. *(Timed suspensions are lifted by a 5-minute sweep. Suspended users still get the in-app notice. Force status: cancel / no-show / complete where the state machine lets an admin — completing requires a started visit and records the commission. Reassign takes the same lock + free-time check as accept. Admin accounts: create, disable/re-enable others, never yourself; sub-roles still TBD.)*
- [x] Daily job: documents expiring within 30 days → admin "needs attention" + provider notice; expired license → pause provider (decision 14). `GET /admin/attention`. *(06:00 Cairo; one notice per document; the pause holds until a newer license is approved as matching.)*
- [ ] Open question for the product team: should `/admin/attention` also list bookings stuck in `accepted` long after their time (provider never started or completed)?

**Exit:** an admin can run the MVP day to day without database access.

### M1.9 MVP launch readiness
- [x] Security pass (§9): rate limits on all public routes, auth on every non-public route, audit of medical data access, encrypted fields checked, no location fields anywhere in the API. *(As tests in `security.test.ts`: every mounted route checked for auth middleware against an explicit public list; role guards; location scan of the OpenAPI doc and every Mongo schema; every sensitive field encrypts. Per-IP limits moved to Redis (shared across instances): 300/min overall, 30/min on public auth routes. Production deps audit clean (firebase-admin 13 → 14, modular API; `uuid` override); CI runs `npm audit --omit=dev`. Findings + open items: `docs/SECURITY.md`.)*
- [x] Load test of search and booking flows against the p95 target. *(`npm run test:load`: 1,000 providers, real app over HTTP. Found and fixed a hotspot — Cairo time conversion in the slot engine (~20 µs/call, ~0.5 ms per provider-day) is now memoized: date search p95 349 → 82 ms, throughput ×4. All reads p95 ≤ 82 ms at 10 clients, ≤ 158 ms at 20; contested bookings never double-book. Numbers in `docs/OPERATIONS.md`.)*
- [x] Staging seed data; backup/restore drill for Mongo; monitoring alerts. *(`npm run seed:staging` (real booking services, idempotent, refuses production). `ops/mongo-backup.sh` + `ops/mongo-restore-drill.sh` and the runbook in `docs/OPERATIONS.md`. `/health/ready` (Mongo + Redis) and `/health/jobs` (503 when a scheduled job goes silent) for alerting.)*
- [x] Deployment ready to go: `Dockerfile`, `deploy/` (compose with Caddy HTTPS + self-hosted profile, env template, backup script), CI Docker build check, `deploy.yml` (main → staging, tag → backup + production after approval, smoke tests). `NODE_ENV=staging` behaves like production but prints OTPs and serves `/docs`. Hosting recommendation, budget and the checklist of what's needed: `docs/DEPLOYMENT.md`.
- [ ] On real infrastructure (needs staging/production to exist): run the restore drill, wire the alerts in `docs/OPERATIONS.md`, re-run the load scenarios against staging.
- [x] Decision: booking `patient_notes` and dispute `description` are encrypted at rest (encrypt-on-write), decrypted only where shown (assigned provider after acceptance, admins), every view audited.
- [x] OpenAPI docs complete for all Phase 1 endpoints and shared with the mobile team (screen map §7.16). *(All Phase 1 endpoints implemented — `api-coverage.test.ts` fails if a spec endpoint is neither built nor assigned to a later milestone; `docs/API_COVERAGE.md` lists all 222 with status. Postman collection generated with the spec (`docs/postman_collection.json`); shareable Swagger page published for the mobile team.)*
- [ ] Legal review of data handling (Law 151/2020) started. *(Data inventory for counsel: `docs/DATA_INVENTORY.md` + generated `docs/DATA_INVENTORY.docx` — data collected, purpose, storage, protection, access, retention, and the open legal questions (11 so far), incl. hosting outside Egypt, which the 2025 executive regulations put under a transfer licence. Updated with every milestone.)*

**Exit:** production deploy; the mobile team signs off on all Phase 1 screens.

---

## Phase 2 — Doctors, payments, chat & growth

### M2.1 Doctors & doctor home visits
- [x] `doctor` provider type, `specialty`, doctor services and categories; search filters for doctors. *(Specialty = a fixed list of 16 (`services/catalog/specialties.ts`, public `GET /specialties`), stored as a key, returned as `{ key, name }`; required for doctors, refused for nurses. Doctor services (كشف منزلي، متابعة منزلية، تقييم شامل لكبار السن) seeded under `doctor_home_visit`, which ships inactive — an admin activates it for launch. `GET /providers?specialty=`; cards show the specialty. Booking, visit reports and reviews work unchanged. Staging seed adds 30 demo doctors.)*
- [ ] Open question for the product team: should doctor visits be priced by grade (ممارس / أخصائي / استشاري) as separate services, and should some services be limited to certain specialties?

### M2.2 Chat (§4.9, §7.12)
- [x] `conversations` (one per booking) + `messages`; available from `accepted` until 24 h after `completed`. *(Only the booking's patient and current provider; others get 404. History stays readable after the window. Message bodies and the list preview encrypted at rest. 30 messages/minute per user.)*
- [x] REST (cursor pagination) + socket events `message.new`, `message.read`; chat push respects notification settings; attachments through `/uploads`. *(`?before=<id>&limit=` with `meta.next_before`; events go to `booking:<id>` and both users' rooms. Push only — no in-app notification per message — never carries the text (Google FCM is abroad), and is skipped while the recipient has the chat open. `can_chat` on patient and provider booking details.)*
- [x] Decision: one conversation per booking and provider. On an admin reassign the old one closes: read-only for the patient (`?conversation_id=`), no access for either provider, kept for admins (`GET /admin/bookings/{id}/conversations`, audited).

### M2.3 Card & wallet payments (§4.8, §7.14)
- [x] `PaymentGateway` interface + implementation for the chosen gateway (decision 1). *(Paymob: Intention API + Unified Checkout, cards + mobile wallets; `services/payments/gateways`. A `fake` gateway for development/tests, refused in production. Adding Fawry = one more class.)*
- [x] `/payments/initiate` (Idempotency-Key), `/payments/{id}`, `/me/payments`. *(Card / wallet bookings behind the `card_payment` flag; `POST /bookings` returns the checkout as `payment_action`; `/payments/{id}/return` bounces the browser to `reaya://payment-result`.)*
- [x] Webhook: signature check, idempotent, **source of truth** for `paid`. *(Paymob HMAC-SHA512 over the documented 20 fields; amount must match; repeats are no-ops; a payment landing after the booking closed, or a second payment, is refunded automatically.)*
- [x] Refunds (admin booking refund, dispute resolution, cancellations). *(Any cancel / decline / expiry of a paid booking refunds in full; `POST /admin/bookings/{id}/refund` (partial allowed, audited); dispute refunds go through the gateway for paid bookings. Amounts are reserved atomically so refunds never exceed the payment.)*
- [x] Ledger: card/wallet bookings credit the provider's share on completion. *(Plus `GET /admin/payments`.)*
- [ ] Before launch: Paymob live merchant account (commercial register, tax card, owner ID, bank account), live keys + integration ids, webhook URL set in the dashboard, and one real sandbox payment end to end (not run yet — no sandbox keys).
- [x] Decision 1: new status `awaiting_payment` (not in spec §5): card / wallet bookings are hidden from providers (lists, detail, sockets, notifications) and hold the slot until paid; the webhook moves them to `pending` and only then sends the request (response clock starts then). Unpaid after `card_payment_window_minutes` (15) → `expired` (notification `booking_payment_expired`). Cash skips it.
- [x] Decision 2: dispute refunds — the admin picks `refund_bearer`: provider (debit on their ledger, capped at their share of the booking; for cash it's owed back), platform, or split by `provider_share`. Default provider when the resolution warns or suspends them, else platform.
- [x] Decision 3: no cancellation fee by default, except the booking's travel fee when the patient cancels after "on the way" (`travel_fee_on_late_cancellation`) or on a no-show (`travel_fee_on_no_show`); it goes to the provider. Card: kept from the refund and credited to the provider. Cash: recorded on the booking (`patient_fee.collected = false`), not collected; admins see per-patient totals (`uncollected_fees`). **Changed with it:** patients can now cancel until the visit starts — the 3-hour `cancellation_free_window_hours` no longer blocks cancelling (it still limits rescheduling). Confirmed by the product owner. A free cancellation of an accepted booking inside that window (before "on the way") is recorded as a **late cancellation** (`booking.lateCancellation`); the patient's admin profile shows `cancellation_record`: late cancellations next to travel-fee charges (count, total, uncollected).

### M2.4 Earnings & payouts (§7.10 earnings, §7.15 finance)
- [x] Provider earnings, ledger, payouts, payout method (independent providers only). *(`/provider/earnings` (period totals + net `wallet_balance` / `commission_due` from one running balance), `/provider/ledger`, `/provider/payouts`, GET/PUT `/provider/payout-method` (bank or mobile wallet; account number encrypted, shown as last 4). Staff have no payouts screen.)*
- [x] Weekly payout batch job on `payout_day` (Thursday); admin payout queue, generate, bulk-approve, mark paid; commission dues; manual ledger adjustments; CSV exports. *(Daily 09:00 Cairo job acts once on payout_day (Redis claim). A payout takes the whole positive balance out at once (`payout` ledger entry) for providers at or above `payout_min_amount` (100 EGP) with a method and no open payout; cancel (not in spec) puts it back. Mark-paid notifies the provider. Exports: bookings / payments / payouts, no names or medical data, formula-injection safe, audited.)*
- [x] Decision: keep the single netted balance; every payout carries a statement (card earnings, commission deducted for cash bookings, commission paid, other deductions, adjustments, net) built from the ledger since the previous payout, also in the payout notification.
- [x] Commission limit: setting `max_commission_due` (1,000 EGP). Above it a provider gets no new cash bookings (patient booking refused with `provider_cash_unavailable`, quote `cash_available: false`, no cash fallback offers, can't accept cash requests); card / wallet still fine. Notified once on crossing `commission_warning_percent` (80%) and once on crossing the limit. `POST /provider/commission/pay` (Idempotency-Key) pays all or part through the gateway; the signed webhook credits a `commission_payment` ledger entry (once). Admin commission dues flag `over_limit` (most owed first).

### M2.5 Packages, promo codes & referrals (§4.7, §4.10, §7.9)
- [x] Packages + subscriptions (purchase through payments), booking against a package, visit decrement/refund (decision 7), package expiry job + low-visits notice. *(Decisions: platform packages, card / wallet upfront only (`features.packages` + `card_payment`); only providers whose own price ≤ the per-visit value (price ÷ visits) are listed / bookable (`GET /providers?package_id=`); the package covers the subtotal, the patient pays the travel fee per visit (package list, details and purchase carry `travel_fee_included: false` + `travel_fee_note`); the provider earns their usual payout and the platform keeps any difference. A visit is held when booked, used on completion, given back on cancel / decline / expiry / no-show. Unpaid purchases are cancelled after `card_payment_window_minutes`; a late payment is refunded. Hourly job: expiry, notice `package_expiry_notice_days` (3) before the end, "one visit left". Also `PATCH /admin/packages/{id}`.)*
- [x] Promo codes (percent/fixed, limits, validity) in the pricing engine; `/promo-codes/validate`; admin CRUD. *(Decision: the platform bears the discount — provider payout unchanged; on cash visits the provider is reimbursed on the ledger (`discount_reimbursement`, its own line on payout statements). Also: max discount for percent codes, minimum subtotal, service list, first-booking-only. A use is released if the booking ends without a visit. Not combinable with a package.)*
- [x] Referrals: code per user, 50 EGP credit each side after the referred user's first completed booking. *(Decision: patients get in-app credit applied automatically to their next bookings (as much as each needs; given back if that booking ends without a visit); a provider referrer gets it on their earnings ledger (`referral_reward`). A phone number can be referred once ever. A booking fully covered by credit / package has total 0 and payment method `covered` (paid; the provider is credited their share like a card booking, so cash reports, commission dues and the commission limit are unaffected; the quote says `payment_required: false`). On a covered no-show (or a cancellation after "on the way") the travel-fee charge paid with credit is kept and credited to the provider, as with card; the package visit and the rest of the credit come back. Reward notices are account notifications, pushed even with promotions turned off.)*
- [x] Admin banners; `GET /home` now returns banners and active package. *(Banner actions: none / promo / service / category / package / https url; optional start / end dates.)*

### M2.6 Video consultations — ⏸ DEFERRED (not cancelled; we'll come back to it)
Put on hold by product decision: no video work at this stage. Until it resumes, the `video_consult` flag stays **off**, and while it is off the server refuses any booking with `type = video` (quote, booking, reschedule and rebook all go through the quote check) and the `video_consultation` category and its services are left out of every public lookup, search, provider service list and booking — even if an admin activates the category (`CatalogService`, `tests/integration/video-deferred.test.ts`). The booking detail's `video` block stays `null`.
- [ ] Video SDK integration (decision pending): room creation on accept, `join_available_at`, booking `type = video` with no travel fee and no `on_the_way`.
- [ ] Feature flag `video_consult` in `/app-config`. *(The flag is already served, off.)*

**Phase 2 exit** (does not depend on video): card payment and payout reconcile in a test run (payment → completion → ledger → payout batch → mark paid), and chat, packages and promos work end to end. ✅ Met by `tests/integration/phase2-exit.test.ts`: a card + promo visit paid by webhook (with chat), a cash visit and a package visit, then a payout batch approved and marked paid; the payout statement adds up and gateway money in − payout = commission − promo + unused package value.

---

## Phase 3 — Organizations

### M3.1 Organization setup & verification (§4.4, §7.11 setup)
- [x] `organizations` (owner role), documents (`commercial_register`, `tax_card`), submit/verify through the existing admin verification queue. *(One organization per owner account and per commercial register number. Same flow as providers: draft → pending → approved / changes_requested / rejected; name, type, commercial register and tax id lock once submitted. `/admin/verifications?type=organization` and the same approve / request-changes / reject / document-review routes (ids tell providers and organizations apart). `GET /me` returns the owner's organization. Also `/admin/organizations` list / details / edit with a custom `commission_rate` (stored now, used for org bookings in M3.3). Address is text only.)*
- [x] Org service areas with travel fee + computed team size per area; org services & prices. *(Team size = approved staff of the organization covering the area and taking bookings — 0 until M3.2 invites. An organization may offer nurse and doctor services. Org packages (`/org/packages`) moved to M3.4.)*

### M3.2 Team management
- [x] Staff invites by SMS → invitee becomes `provider_staff` linked to the org (still needs document verification). *(Approved organizations only, 30 invites a day, valid 7 days, one open invite per number. New numbers: the OTP verify response lists `staff_invites`; register with `role: provider_staff` + `staff_invite_id`. Decision: an independent provider can accept in the app (`/provider/staff-invites`) only with no active bookings, a zero balance and no open payout — verification carries over, their own areas / services / prices are cleared; patient and owner accounts can't join. Staff verification needs profile + documents only. Privacy default until counsel answers inventory question 11: the invite SMS carries only the organization's name and the app link (`APP_DOWNLOAD_URL`); never-accepted invites (expired / declined / revoked) are deleted 30 days after expiry by the daily `STAFF_INVITE_PURGE` job, keeping only `lapsedInvitesCount` (shown in `GET /org` `invite_stats`).)*
- [x] Staff list/details/performance, suspend/activate/remove, staff availability and areas set by the owner. `provider_staff` cannot edit prices/services/areas and has no payouts. *(Services from the organization's list (matching the member's type, at the org's price); areas from the org's list (at its travel fee). Suspension is within the organization (not an account suspension) and drops them from team size. Decision: removal is always allowed — they become an independent provider, verification kept, not accepting until they set their own areas, services and prices. The role is read from the database on every request, so joining / leaving applies without a new login. Staff are never listed or bookable as independents (search, profile, quote, fallback, admin reassign); `source=organization` search returns nothing until M3.3 adds organization cards.)*

### M3.3 Org bookings, assignment & broadcast (§6.6, §6.10)
- [x] Bookings to an org get `assignment_mode = organization` and `assignment_deadline = now + org_assign_deadline_minutes`. *(Card / wallet: once paid. The org's price, travel fee and `commission_rate` override apply; the quote needs one eligible staff member free then (area, service, preferred gender). Earnings go to the organization's ledger (`earningsOwnerOf`), and the cash commission limit applies per organization.)*
- [x] Owner queue, eligible-staff list (area, free slot, preferred gender; clashes flagged `available: false`), assign / reassign (`SLOT_UNAVAILABLE`), "send to all suitable" broadcast to staff, decline, cancel. After the deadline → `ASSIGNMENT_DEADLINE_PASSED`. *(Decisions: assigning accepts the booking at once; owners see operational details only — patient name, phone and full address once a staff member is assigned, never booking notes, medical data or visit reports. Broadcast offers go to staff's `/provider/offers`, first to accept wins. Decline = straight to fallback if the patient allowed it, else declined. Reassign closes the previous member's chat. Patient reschedule (decision): the assigned staff member keeps it when still eligible and free at the new time (stays accepted; staff and owner told the new time), otherwise it goes back to the queue with a fresh deadline.)*
- [x] Deadline warning job (10 min left) → owner notification. *(Part of the 30-second deadline sweep; once per booking.)*
- [x] Deadline job reuses the Phase 1 fallback broadcast, now including other organizations. *(Decision: another organization takes an offered request by assigning a free staff member — `GET /org/offers`, then `POST /org/bookings/{id}/assign`; first to accept across everyone wins; the booking becomes theirs at the quoted price. The original organization keeps seeing it (and gets `ASSIGNMENT_DEADLINE_PASSED`) until someone takes it; direct requests that time out now reach organizations too.)*
- [x] Removing a staff member (decision after M3.2): their active bookings are taken from them and go back to the organization's unassigned queue (same deadline and fallback rules as any org booking), and they lose access to those bookings and their chats immediately. Test it. *(`OrgBookingService.takeBackFrom`; tested.)*
- [x] Organization cards in search (`source=organization`) and booking an organization by `organization_id`; the org's `commission_rate` override applies. *(Decision: one card per organization — price, travel fee, team size in the area, rating weighted over its staff, next free slot. `GET /providers/{id}`, `/reviews` and `/slots` take an organization id too (`kind` tells them apart; slots accept `area_id` / `gender`).)*

### M3.4 Org dashboard, reports, finance & subscriptions
- [x] Dashboard KPIs + alerts, reports grouped by day/staff/service with on-time rate. *(Dashboard: bookings by state, staff online, gross / commission / net for completed visits, staff-weighted rating; alerts for unassigned bookings, offers from other organizations and the commission limit. Reports also give cancellation rate and average rating.)*
- [x] Org earnings/ledger/payouts (same shapes as provider), invoices + PDF, custom commission rate per org (admin). *(Payouts, payout batches, commission dues and admin adjustments cover organizations (`owner_type`); `POST /org/commission/pay` pays what's owed in the app. Decision: invoices are monthly **statements** of platform charges (commission on the month's completed visits + plan fees − credits), clearly not tax invoices — ETA e-invoices later, once the accountant confirms VAT. Arabic PDF (pdfkit + Noto Naskh Arabic, OFL) in private storage, made by a daily job for the previous Cairo month, once.)*
- [x] Subscription plans (admin) + org subscribe/change plan, `max_staff` enforcement. *(Decisions: a free default plan ("starter", seeded) so organizations start without paying; a paid plan is charged monthly as a plan charge (`org_plan_charges`), kept off the earnings balance: it is taken from available earnings (daily and before each payout — then it is a `subscription_fee` ledger entry) or paid in the app (`POST /org/subscription/pay`). Decision after review: plan fees never count toward `max_commission_due` (cash commission only) and never pause bookings; unpaid `plan_fee_notice_days` (14) after the charge → the owner is told, unpaid at `plan_fee_downgrade_days` (21) → moved to the free starter plan (the fee stays owed; normal over-limit rules apply). Changing plan starts a new period at once; the unused part of a paid month comes off what is owed first, the rest back to the balance. Over `max_staff` (members + open invites) new invites and joins are refused; existing staff keep working.)*
- [x] Org packages (moved here from M3.1). *(Decision: sold upfront like platform packages; booked with that organization only; each completed visit earns the per-visit value minus the organization's commission (+ travel fee); unused visits stay with the platform.)*

### M3.5 Advanced admin & analytics
- [x] Admin sub-roles mapped to permissions. *(Decision: `super_admin` (everything: admin accounts, settings, audit log, plans, catalog writes), `verifier` (verification queue and documents; providers / organizations read; suspend a listing), `support` (users suspend / warn, bookings force status / reassign, disputes, reviews, booking chats and notes, audited), `finance` (payments, refunds, payouts, commission dues, ledger adjustments, exports, org commission rate), `marketing` (promo codes, banners, packages, marketing broadcasts); everyone gets the dashboard, analytics and the read-only lists they need. Existing admins became `super_admin`. One central table (`admin-permissions.ts`) keyed on route + method; a route with no rule is super_admin only. Booking notes and dispute descriptions are hidden from roles other than super_admin / support.)*
- [x] `/admin/analytics` time series. *(Bookings, completed visits, GMV, revenue, cancellation rate, active providers, new patients / providers / organizations; by Cairo day / week (from Saturday) / month, zero-filled; max 92 days by day.)*
- [x] Segment push broadcasts (`role` + `area_ids`). *(Decision: two types. **marketing** (default; super_admin + marketing): in-app for everyone in the segment, push only with promotions on, `broadcast_marketing_daily_max` (3) a Cairo day. **announcement** (maintenance, policy, important updates; super_admin only, reason required): always pushed regardless of the promotions setting, `broadcast_announcement_daily_max` (1) a day, never for offers. Both skip suspended / deleted accounts and admins, preview the audience (`dry_run`), and are audited. Sent in resumable batches by the `broadcasts` maintenance job.)*
- [ ] Insurance partnerships — scope to be defined.

**Phase 3 exit:** an organization onboards, invites staff, receives a booking, assigns or broadcasts it, and sees it in reports and invoices; an unassigned booking falls back to other providers after the deadline. *(Covered end to end by `tests/integration/phase3-exit.test.ts`. Insurance partnerships stay open until their scope is defined.)*

### Launch preparation
- [x] Test numbers with a fixed sign-in code for store reviewers and testers. *(Decision: allowlist only (`TEST_PHONE_NUMBERS` / `TEST_OTP_CODE`), every use audited; in production the fixed code never opens a real account or an admin, and test accounts only find and book test providers / organizations — real patients never see them; analytics leave them out.)*
- [x] Account-deletion web page for Google Play (`/api/v1/account-deletion`): SMS code, shows whose account, then the same `DELETE /me` as the app.
- [x] Consent recording. *(Decision: terms, privacy and health-data consent as numbered versions published by a super admin — counsel's wording plugs in without a release; nothing required until a version is published; sign-up then requires the current ones for the role (health data: patients); a newer version shows as not up to date in `GET /me/consents`; acceptances and withdrawals are append-only records with time and IP.)*
- [x] Interim rule for withdrawn health-data consent (until counsel answers). *(Decision: account and bookings continue; the medical profile, conditions, medications, allergies and documents are kept but not shared with providers (they see `medical_summary_withheld`) and can't be edited (403 `HEALTH_DATA_CONSENT_WITHDRAWN`, whose message is the notice); the patient sees a notice and is notified; consenting again restores everything.)*
- [ ] Everything else on the launch checklist (hosting, staging, Paymob live, SMS provider, PDPC licence, store accounts) — tracked in the launch readiness page.

---

## Clinic visits (approved 8 Oct 2026)

Doctor bookings become a **clinic visit** (patient goes to the clinic) or a **home visit** (as today). Nurses stay home-only; video stays deferred. Plan: https://claude.ai/artifact/Fz9GDDo6y4i6jn9hXE21QM. All 14 recommendations accepted: fixed appointment slots (slot length per clinic); instant confirmation by default (doctor can turn it off; no 3-minute window or fallback for clinic bookings); up to 3 clinics per doctor (setting), each verified with a clinic licence, one shared calendar; 4-digit visit code to start (without it: reason, audited); no late-cancellation / no-show fee at launch (settings, default 0%); reuse the free cancellation window; same commission with an optional clinic rate; organization deadline → auto-assign a free doctor at the same branch, else expire + refund + notify, never another address; one search card per clinic / branch; any or a specific doctor at a branch; organization prices per organization; clinic phone shown after booking; same service with a price per visit type. Everything behind `features.clinic_visits`.

### C1 Clinics and doctor setup
- [x] `clinic_visit` booking type; catalog `visitTypes` + per-type price limits; per-visit-type service prices; clinics (text address only) with licence and admin verification; clinic hours with overlap rules; settings and feature flag. *(No data migration needed: a service entry without `visitType` counts as a home visit, and every home-visit match goes through `visit-types.ts`. Seeded doctor services renamed to neutral names ("كشف", "متابعة") since one service now covers home and clinic. `features` settings can be updated partially, and older stored values pick up new flags with their defaults. Clinic quotes are refused until C3.)*

### C2 Search and slots
- [x] Search by clinic area, one card per clinic, profile clinic tab, slots per clinic, one calendar across home and clinic. *(`GET /providers?visit_type=clinic_visit`: approved, active clinics in `area_id` with an approved independent doctor who takes bookings, prices the service as a clinic visit and has hours there; card = clinic price, no travel fee, clinic name + area (never the phone or street). Slots: `?visit_type=clinic_visit&clinic_id=` — fixed appointments of the clinic's length (default: the service's duration). Profile: `visit_types` and `clinics` (full text address, hours, clinic prices, no phone). All behind `features.clinic_visits`; packages stay home-only until C5.)*

### C3 Clinic booking flow
- [x] Quote / book with a clinic, instant confirm, visit-code start, no-show and fee settings, cancellations and refunds, clinic notifications and reminders. *(Quote with `type: clinic_visit` + `clinic_id`, no `address_id`: no travel fee, `clinic_commission_rate` when set, the slot must be a free appointment at that clinic. The booking keeps the clinic's address in `address` and `clinic` {name, phone, instantConfirm}; never falls back. Instant confirm: the system moves it to accepted right after booking (cash / covered) or payment (card), allowed for clinic visits only in the state machine; a reschedule is confirmed again at the new time. Patients see the clinic phone and a 4-digit visit code once confirmed; doctors start with the code (5 tries) or without it with a reason (audited); no "on the way"; no-show from start + `clinic_no_show_grace_minutes`; late-cancellation / no-show fees are a percentage of the consultation (0 by default). Admins can't reassign a clinic appointment to another doctor. Against slot hoarding (decision after review): one account's active, not-yet-ended clinic appointments may not overlap; one upcoming appointment with the same doctor per patient profile; at most `max_upcoming_clinic_bookings` (3) in total, family members counting toward the account.)*

### C4 Organizations with branches
- [x] Branches, doctors per branch with hours, cards per branch, any / specific doctor, branch-limited queue and the deadline rule, reports by branch. *(`/org/branches` (review like any clinic; the owner is told the decision), `PUT /org/branches/{id}/doctors/{staffId}` places a staff doctor with hours there (overlap rules as for clinics). Search: one organization card per branch (its clinic price, doctors there, earliest free). Booking: `organization_id` + `clinic_id` (+ `provider_id` for a specific doctor → confirmed at once; without → owner queue, assign only doctors at that branch). Deadline (rule after review): the system assigns a free doctor at the branch who matches the patient's preferred gender — the one with the fewest appointments that day at that branch, then the higher rating; with none, it expires (refunded) and the patient is told to choose again. `/org/reports?group_by=branch`.)*
- [x] **Branch reception** role (added at approval): invited by the owner per branch; sees only that branch's appointments for today (patient name, time, doctor, status); checks in with the visit code and marks no-shows; no medical data, booking notes, visit reports, finance or prices; every action audited; in the permission tests and the data inventory.

### C5 Money, admin and hand-off
- [x] Packages and promos by visit type, optional clinic commission, admin filters and analytics by visit type, needs-attention, data inventory, mobile change notes. *(Packages have `visit_type` (a clinic package covers clinic visits only, its area check uses clinics); promo codes may be limited to visit types; `/admin/bookings` and `/admin/analytics` take `visit_type`; `/admin/attention` lists clinic visits never started; clinic and branch licences: a warning 30 days ahead and, once expired, the clinic goes back to "changes requested" until renewed (daily document job). Also fixed: a home package's area check no longer counts clinic prices. Mobile notes: `docs/MOBILE_CHANGES_CLINIC_VISITS.md`.)*

---

## Cross-cutting rules (apply in every milestone)

- **No location data**, ever: no lat/lng fields, no distance logic, matching by area only (§1).
- Money in integer piastres; times in UTC; display time zone `Africa/Cairo`.
- Every booking state change goes through the state machine — never update `status` directly.
- Every admin write and every medical-data read is audited.
- All user-facing text goes through translation files (Arabic now, English later).
- Each milestone ships with tests for its business rules (pricing, transitions, eligibility, concurrency) and updated OpenAPI docs.
