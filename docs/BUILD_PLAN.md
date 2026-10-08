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
- [ ] Legal review of data handling (Law 151/2020) started. *(Data inventory prepared for counsel: data collected, purpose, storage, protection, access, retention, and 10 questions — incl. hosting outside Egypt, which the 2025 executive regulations put under a transfer licence.)*

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
- [ ] Open question for the product team: should commission owed on cash bookings be deducted automatically from card earnings (today one running balance nets them), or settled separately?

### M2.5 Packages, promo codes & referrals (§4.7, §4.10, §7.9)
- [ ] Packages + subscriptions (purchase through payments), booking against a package, visit decrement/refund (decision 7), package expiry job + low-visits notice.
- [ ] Promo codes (percent/fixed, limits, validity) in the pricing engine; `/promo-codes/validate`; admin CRUD.
- [ ] Referrals: code per user, 50 EGP credit each side after the referred user's first completed booking.
- [ ] Admin banners; `GET /home` now returns banners and active package.

### M2.6 Video consultations
- [ ] Video SDK integration (decision pending): room creation on accept, `join_available_at`, booking `type = video` with no travel fee and no `on_the_way`.
- [ ] Feature flag `video_consult` in `/app-config`.

**Phase 2 exit:** card payment and payout reconcile in a test run (payment → completion → ledger → payout batch → mark paid), and chat, packages and promos work end to end.

---

## Phase 3 — Organizations

### M3.1 Organization setup & verification (§4.4, §7.11 setup)
- [ ] `organizations` (owner role), documents (`commercial_register`, `tax_card`), submit/verify through the existing admin verification queue.
- [ ] Org service areas with travel fee + computed team size per area; org services & prices.

### M3.2 Team management
- [ ] Staff invites by SMS → invitee becomes `provider_staff` linked to the org (still needs document verification).
- [ ] Staff list/details/performance, suspend/activate/remove, staff availability and areas set by the owner. `provider_staff` cannot edit prices/services/areas and has no payouts.

### M3.3 Org bookings, assignment & broadcast (§6.6, §6.10)
- [ ] Bookings to an org get `assignment_mode = organization` and `assignment_deadline = now + org_assign_deadline_minutes`.
- [ ] Owner queue, eligible-staff list (area, free slot, preferred gender; clashes flagged `available: false`), assign / reassign (`SLOT_UNAVAILABLE`), "send to all suitable" broadcast to staff, decline, cancel. After the deadline → `ASSIGNMENT_DEADLINE_PASSED`.
- [ ] Deadline warning job (10 min left) → owner notification.
- [ ] Deadline job reuses the Phase 1 fallback broadcast, now including other organizations.

### M3.4 Org dashboard, reports, finance & subscriptions
- [ ] Dashboard KPIs + alerts, reports grouped by day/staff/service with on-time rate.
- [ ] Org earnings/ledger/payouts (same shapes as provider), invoices + PDF, custom commission rate per org (admin).
- [ ] Subscription plans (admin) + org subscribe/change plan, `max_staff` enforcement.

### M3.5 Advanced admin & analytics
- [ ] `/admin/analytics` time series, admin sub-roles (`super_admin | verifier | support | finance`) mapped to permissions, segment push broadcasts.
- [ ] Insurance partnerships — scope to be defined.

**Phase 3 exit:** an organization onboards, invites staff, receives a booking, assigns or broadcasts it, and sees it in reports and invoices; an unassigned booking falls back to other providers after the deadline.

---

## Cross-cutting rules (apply in every milestone)

- **No location data**, ever: no lat/lng fields, no distance logic, matching by area only (§1).
- Money in integer piastres; times in UTC; display time zone `Africa/Cairo`.
- Every booking state change goes through the state machine — never update `status` directly.
- Every admin write and every medical-data read is audited.
- All user-facing text goes through translation files (Arabic now, English later).
- Each milestone ships with tests for its business rules (pricing, transitions, eligibility, concurrency) and updated OpenAPI docs.
