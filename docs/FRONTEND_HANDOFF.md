# Reaya+ backend: handover for the frontend and mobile teams

Status on 9 Oct 2026: every endpoint in the backend spec (`docs/Reaya_Backend_Spec.md`, v2.2) is built: 222 of 222.
On top of that the API has 51 endpoints the spec does not list, and a number of spec endpoints changed shape
while we built them. This file lists what is ready, what changed against the spec, and what was added, so
you can update the apps.

Read it in this order:

1. [What can break an app built from the spec](#1-what-can-break-an-app-built-from-the-spec)
2. [Rules for every request](#2-rules-for-every-request)
3. [Changes to spec endpoints](#3-changes-to-spec-endpoints)
4. [Endpoints added to the spec](#4-endpoints-added-to-the-spec)
5. [Enums](#5-enums)
6. [Error codes](#6-error-codes)
7. [Realtime and push](#7-realtime-and-push)
8. [Behaviour that changes screens](#8-behaviour-that-changes-screens)
9. [Not built or switched off](#9-not-built-or-switched-off)

Exact request and response shapes are in the API reference (Swagger: `/docs` on any non-production server,
or `docs/openapi.json`; a Postman collection is in `docs/postman_collection.json`). Two fields are returned
by the API but missing from the reference today: `cash_available` on a quote and `features.clinic_visits`
in `GET /app-config`.

Marks used below: **NEW** = not in the spec, **CHANGED** = differs from the spec.

---

## 1. What can break an app built from the spec

| #   | Change                                                                                                                                                            | What to do                                                                                   |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1   | Ids are 24-character strings (MongoDB ids), not UUIDs.                                                                                                            | Treat every id as an opaque string.                                                          |
| 2   | Realtime is **Socket.IO**, not a raw WebSocket at `/ws?token=`. Rooms are `user:<id>` and `booking:<id>` (colon).                                                 | Use a Socket.IO client. See [section 7](#7-realtime-and-push).                               |
| 3   | New booking status `awaiting_payment` (card and wallet bookings before payment).                                                                                  | Add it to the status enum and show "waiting for payment".                                    |
| 4   | New payment method `covered` (total is 0 after a package, promo or credit). Only the server sets it.                                                              | Accept it when reading; skip the payment step when the quote says `payment_required: false`. |
| 5   | New booking type `clinic_visit` and new role `reception`.                                                                                                         | Accept both in enums. Details in `docs/MOBILE_CHANGES_CLINIC_VISITS.md`.                     |
| 6   | `POST /auth/register` requires `gender` and `date_of_birth`, and requires `consents` once a consent text is published.                                            | Add the fields and a consent step at sign-up.                                                |
| 7   | A refresh token works once. Using an old one ends the whole session.                                                                                              | Never run two refreshes at the same time; queue requests behind one refresh.                 |
| 8   | Validation errors are always `422 VALIDATION_ERROR` with `fields`, never 400.                                                                                     | Read `error.fields` to mark inputs.                                                          |
| 9   | Address bodies reject unknown fields. Sending coordinates fails with 422.                                                                                         | Send only the documented text fields. No location data anywhere.                             |
| 10  | `Idempotency-Key` must be a UUID and is required on six routes (three are new).                                                                                   | See [section 2](#2-rules-for-every-request).                                                 |
| 11  | Chat messages page with `before` and `limit`, not `page`.                                                                                                         | See [Chat](#chat).                                                                           |
| 12  | `GET /providers` returns cards of two kinds: `provider` and `organization`. `GET /providers/{id}` accepts both ids and answers with a different shape per `kind`. | Branch on `kind`.                                                                            |
| 13  | `specialty` is an object `{ key, name }`, not a string.                                                                                                           | Show `name`, send `key`.                                                                     |
| 14  | An invalid promo code is a 422 error (`PROMO_INVALID`, `PROMO_EXPIRED`, `PROMO_LIMIT_REACHED`), never `valid: false`.                                             | Handle the error codes.                                                                      |
| 15  | `DELETE /me` answers 202 and signs the user out at once. It is refused while the user has active bookings.                                                        | Sign out locally after 202.                                                                  |
| 16  | File links (`file_url`, `avatar_url`, `logo_url`, `image_url`) are signed and live 10 minutes.                                                                    | Don't store them; fetch the object again when you need the file.                             |
| 17  | Patients can cancel until the visit starts (the spec blocked it inside 3 hours). A fee may apply.                                                                 | Show `cancellation_fee` and `refund_amount` from the cancel response.                        |
| 18  | `/home`, `/providers…`, `/packages` and `/subscription-plans` need a signed-in user.                                                                              | No guest browsing of these screens.                                                          |

---

## 2. Rules for every request

### Base and envelopes

- Base path: `/api/v1`. JSON is `snake_case`.
- Success: `{ "data": …, "meta"?: … }`. Empty successes are `204` with no body.
- Error: `{ "error": { "code": "…", "message": "…", "fields"?: { "<input>": ["…"] } } }`. `message` is
  already translated; show it as is. Branch on `code`.
- Lists: `?page=1&per_page=20` (max 100) → `meta: { page, per_page, total, last_page }`.
- List entries in validation errors are named by path, for example `areas.2.travel_fee` or `hours.0`.

### Headers

| Header                                 | Use                                                                                                                                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Authorization: Bearer <access_token>` | All routes except the public ones below.                                                                                                                                                         |
| `Accept-Language: ar`                  | Language of messages and names. Order: this header, then the user's saved language, then Arabic. English texts are not written yet, so everything comes back in Arabic.                          |
| `Idempotency-Key: <uuid>`              | Required on `POST /bookings`, `POST /payments/initiate`, `POST /packages/{id}/subscribe`, and **NEW** `POST /provider/commission/pay`, `POST /org/commission/pay`, `POST /org/subscription/pay`. |
| `X-Request-Id`                         | Optional. The server echoes it (or creates one). Send it with bug reports.                                                                                                                       |

Idempotency key behaviour: same key and same body replays the first answer for 24 hours (header
`Idempotent-Replayed: true`); same key while the first request is still running gives `409 CONFLICT`; same
key with a different body gives `422 IDEMPOTENCY_KEY_REUSED`. Create one key per user action and reuse it
on retries.

### Sign-in

1. `POST /auth/otp/request` with the phone (Egyptian mobiles only: `+201[0125]########`). Code: 4 digits,
   valid 2 minutes, 5 attempts. Resend after 60 seconds.
2. `POST /auth/otp/verify`:
   - existing user → `access_token` (1 hour) and `refresh_token` (30 days);
   - new number → `registration_token` (15 minutes) and `staff_invites[]` if an organization invited this
     number.
3. `POST /auth/register` with `Authorization: Bearer <registration_token>`.
4. On `401 TOKEN_EXPIRED` call `POST /auth/refresh`; it returns a new pair.

Other answers to expect on any request: `403 ACCOUNT_SUSPENDED`, `401` for a deleted account,
`503 SERVICE_UNAVAILABLE` in maintenance mode, `429 RATE_LIMITED` with a `Retry-After` header.

Public routes (no token): `/health*`, `/app-config`, `/governorates`, `/governorates/{id}/areas`, `/areas`,
`/service-categories`, `/services`, `/services/{id}`, `/specialties`, `/consent-documents`, the `/auth/otp/*`,
`/auth/refresh` and `/auth/logout` routes, and `/payments/{id}/return`.

### Money, dates, times

- Money is a whole number of piastres (`15000` = 150 EGP), with `currency: "EGP"`.
- Instants are UTC ISO strings (`scheduled_start`, `created_at`, …).
- Calendar dates (`date`, `from`, `to`) are Cairo dates, `YYYY-MM-DD`.
- Weekly hours are Cairo local time `"HH:mm"`; `day_of_week` 0 is Sunday.
- Egypt changes its clocks in summer. Convert with the `Africa/Cairo` time zone; never add a fixed offset.

### Names

Public objects carry one `name` in the request language. Admin objects carry `name_ar` and `name_en`.

### Uploads

1. `POST /uploads` (multipart: `file`, `purpose`) → `{ file_key, mime, size }`.
2. Send `file_key` to the endpoint that attaches it. It must be the same user and the same purpose.

Purposes: `provider_document`, `org_document`, `medical_document`, `chat`, `visit_report`, `avatar`, and
**NEW** `dispute`, `banner`, `clinic_licence`. Limit 10 MB; JPG, PNG or PDF (avatars: images only). The
server checks the real file type. A file that is never attached is removed after a day.
`POST /me/avatar` and `POST /org/logo` take the file directly.

### Limits

300 requests a minute per IP (30 on the public sign-in routes); OTP 1 a minute and 3 per 10 minutes per
phone; uploads 60 an hour per user; chat 30 messages a minute per user.

### `GET /app-config`

```json
{
  "data": {
    "min_app_version": { "android": "1.0.0", "ios": "1.0.0" },
    "support_phone": "",
    "emergency_number": "123",
    "cancellation_free_window_hours": 3,
    "cancellation_policy": "…",
    "direct_request_response_minutes": 3,
    "features": { "video_consult": false, "card_payment": false, "packages": false, "clinic_visits": false }
  }
}
```

**NEW**: `cancellation_policy` (ready-to-show text) and `features.clinic_visits`. Hide a feature's screens
while its flag is `false`: `card_payment` (card and wallet payment), `packages` (also needs
`card_payment`), `clinic_visits`, `video_consult` (stays off; video is not built).

---

## 3. Changes to spec endpoints

Only differences are listed. Anything not mentioned works as the spec says.

### Auth and account

| Endpoint                | Change                                                                                                                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /auth/otp/verify` | New-user answer adds `staff_invites: [{ id, organization_name, kind, type }]` (`kind`: `staff` or `reception`; `type`: `nurse`, `doctor`, or `null` for reception).                                                                         |
| `POST /auth/register`   | `role`: `patient`, `provider`, `owner`, `provider_staff`, `reception`. The last two need `staff_invite_id`. `gender` and `date_of_birth` are required. Optional `consents: [{ kind, version }]`, required once consent texts are published. |
| `POST /auth/refresh`    | One use per refresh token (see section 1).                                                                                                                                                                                                  |
| `GET /me`               | `provider_profile` is `{ id, type, verification_status, is_accepting_bookings }`; `organization` is `{ id, name, type, verification_status }`. `PATCH /me`, `POST /me/avatar` and `POST /auth/phone/change/verify` return this same object. |
| `DELETE /me`            | `202 { status: "deleted", deletion_requested_at }`.                                                                                                                                                                                         |
| `POST /me/devices`      | `204`.                                                                                                                                                                                                                                      |
| `GET /me/referral`      | Adds `credit_balance`.                                                                                                                                                                                                                      |

### Lookups

| Endpoint                  | Change                                                                                  |
| ------------------------- | --------------------------------------------------------------------------------------- |
| `GET /service-categories` | Items add `key`.                                                                        |
| `GET /services`           | Items add `visit_types` (`home_visit`, `clinic_visit`); `starting_price` can be `null`. |
| `GET /areas`              | Paginated; adds `governorate_name` and the filter `governorate_id`.                     |

### Addresses

- Shape: `{ id, label, governorate: { id, name }, area: { id, name }, street, building, floor, apartment, landmark, notes, is_default, is_bookable, full_text }`.
- `PATCH` does not take `is_default`; use `POST /addresses/{id}/default`.

### Patient profiles and medical data

- Profiles carry `date_of_birth` and `age`.
- `blood_type` is one of `A+ A- B+ B- AB+ AB- O+ O-`.
- Profile detail adds `health_data_paused` and `health_data_notice` (see
  [health-data consent](#consent-and-health-data)).
- Allergy `severity`: `low`, `medium`, `high`.
- Documents: `{ id, type, title, mime, file_url, uploaded_at }`.

### Home, search, provider profile, slots

| Endpoint                    | Change                                                                                                                                                                                                                                                                                  |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /home`                 | `categories[]` add `key`; `active_package` adds `expires_at`; `banners[]` are `{ id, title, image_url, action, value }` with `action`: `none`, `promo`, `service`, `category`, `package`, `url`.                                                                                        |
| `GET /providers`            | New filters `specialty`, `package_id`, `visit_type`. Cards add `kind` (`provider` or `organization`), `travel_fee`, `specialty`, `team_size`, `visit_type`, `clinic`. An organization is one card: its price, travel fee, team size in the area, rating over its staff, next free slot. |
| `GET /providers/{id}`       | Takes a provider or an organization id. Provider: adds `avatar_url`, `gender`, `is_accepting_bookings`, `visit_types`, `clinics[]`. Organization: `organization_type`, `description`, `team_size`, `clinics[]` with `doctors[]`.                                                        |
| `GET /providers/{id}/slots` | New filters `visit_type`, `clinic_id`, `doctor_id`, `area_id`, `gender`. Home slots start every 30 minutes, at least 60 minutes from now, at most 60 days ahead.                                                                                                                        |
| Reviews                     | `patient_name` is the first name and an initial.                                                                                                                                                                                                                                        |

### Patient bookings

| Endpoint                         | Change                                                                                                                                                                                                                                                                                              |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /bookings/quote`           | `address_id` is required for home visits only; clinic visits send `clinic_id`. Answer adds `discounts: { promo, package, credit }`, `promo_code`, `package_subscription_id`, `payment_required`, `cash_available`, `expires_at`. A quote is valid 10 minutes. `type: video` is refused.             |
| `POST /bookings`                 | `status` can be `awaiting_payment` (card, wallet) or `accepted` (clinic visit confirmed at once). Card and wallet answers carry `payment_action: { payment_id, checkout_url, expires_at }`. When the quote said `payment_required: false`, `payment_method` is ignored and comes back as `covered`. |
| `GET /bookings`                  | Items: `{ id, reference_code, status, type, service_name, scheduled_start, scheduled_end, provider_name, organization_name, total, currency }`.                                                                                                                                                     |
| `GET /bookings/{id}`             | Adds `organization`, `clinic: { id, name, phone }`, `visit_code`, `promo_code`, `package_subscription_id`, `address.landmark`, `price.travel_fee`, `price.discounts`, `timeline[].note`. `provider.phone` appears only after the booking is accepted. `video` is always `null`.                     |
| `POST /bookings/{id}/cancel`     | Allowed until the visit starts. Answer carries `cancellation_fee` and `refund_amount`.                                                                                                                                                                                                              |
| `POST /bookings/{id}/reschedule` | Returns the full booking. Allowed while `pending`, or `accepted` and outside the free window; otherwise `409 CANCELLATION_NOT_ALLOWED`. A home visit goes back to `pending`.                                                                                                                        |
| `POST /bookings/{id}/rebook`     | Body `{ scheduled_start }`; returns a quote.                                                                                                                                                                                                                                                        |
| `POST /bookings/{id}/review`     | `tags`: `punctual`, `professional`, `gentle`, `clean`, `friendly`, `explains_well`. `201`.                                                                                                                                                                                                          |
| `POST /bookings/{id}/dispute`    | Also allowed on a `no_show`. Open for 48 hours after the visit. Attachments use upload purpose `dispute`. `201 { id, booking_id, status, reason_code, description, created_at }`.                                                                                                                   |

### Provider

| Endpoint                              | Change                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET / PATCH /provider/profile`       | Adds `specialty`, `languages` (`ar`, `en`, `fr`, `de`), `license_number`, `syndicate_number`, `rating_avg`, `rating_count`, `completed_visits`, `onboarding.clinics_set`. `specialty` is required for doctors and refused for nurses (keys from `GET /specialties`). Type, licence and syndicate numbers can be edited only while the status is `draft`, `changes_requested` or `rejected`.                    |
| `POST /provider/documents`            | Optional `expires_at`. Documents carry `status` (`pending`, `matching`, `not_matching`) and `review_note`.                                                                                                                                                                                                                                                                                                     |
| `POST /provider/submit-verification`  | Also allowed from `changes_requested`. A 422 names each missing onboarding item.                                                                                                                                                                                                                                                                                                                               |
| `GET / PUT /provider/service-areas`   | `{ area_id, name, governorate_name, travel_fee, max_travel_fee, is_bookable }`. A fee above `max_travel_fee` is a 422.                                                                                                                                                                                                                                                                                         |
| `GET / PUT /provider/services`        | Entries carry `visit_type` (default `home_visit`). `GET` adds `min_price`, `max_price`, `is_available`.                                                                                                                                                                                                                                                                                                        |
| `PUT /provider/availability`          | No overlaps, including with clinic hours.                                                                                                                                                                                                                                                                                                                                                                      |
| `GET /provider/home`                  | `{ today_visits[], pending_requests[], open_offers, today_earnings, currency }`.                                                                                                                                                                                                                                                                                                                               |
| `GET /provider/offers`                | Items: `{ id, booking_id, service_name, area_name, scheduled_start, scheduled_end, provider_payout, expires_at }`.                                                                                                                                                                                                                                                                                             |
| `GET /provider/bookings/{id}`         | Adds `type`, `payment_status`, `is_on_time`, `can_chat`, `clinic`, `check_in`, `medical_summary_withheld`, `price.travel_fee`. Patient name, phone, full address and notes are hidden until the provider accepts. `allowed_actions`: `accept`, `decline`, `on_the_way`, `start` (or `start_with_code` for clinic visits), `complete`, `no_show`, `cancel`, `cash_collected`. Build the buttons from this list. |
| `POST /provider/bookings/{id}/start`  | Clinic visits: body `{ visit_code }` or `{ without_code_reason }`.                                                                                                                                                                                                                                                                                                                                             |
| `POST /provider/bookings/{id}/cancel` | `reason_code`: `emergency`, `patient_request`, `schedule_conflict`, `other`.                                                                                                                                                                                                                                                                                                                                   |
| `GET /provider/earnings`              | Adds `payout_method` and `commission_limit: { max, warning, over_limit }`.                                                                                                                                                                                                                                                                                                                                     |
| `GET /provider/ledger`                | New `type` values: `commission_payment`, `discount_reimbursement`, `referral_reward`, `credit_used`, `credit_restored`, `subscription_fee`, `subscription_credit`.                                                                                                                                                                                                                                             |
| `GET /provider/payouts`               | Each payout has a `statement` (`card_earnings`, `commission_deducted`, `commission_paid`, `discounts_reimbursed`, `referral_rewards`, `subscription_fees`, `other_deductions`, `adjustments`, `net`). Status: `pending`, `approved`, `paid`, `cancelled`.                                                                                                                                                      |
| `PUT /provider/payout-method`         | Body `{ type: bank or wallet, account_holder, bank_name?, wallet_provider?, account_number }`. `wallet_provider`: `vodafone_cash`, `orange_cash`, `etisalat_cash`, `we_pay`, `instapay`. The answer is masked (`account_number_last4`, `label`).                                                                                                                                                               |

Staff members of an organization (`provider_staff`) use the same provider routes, but cannot change areas
or services and have no earnings screens.

### Organization owner

| Endpoint                                | Change                                                                                                                                                                                                                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /org`                              | Adds `onboarding { info_completed, documents_uploaded, areas_selected, services_set, can_submit }` and `invite_stats { pending, accepted, not_accepted }`.                                                                                                                |
| `GET / PUT /org/service-areas`          | Entries take `is_active`; `GET` adds `team_size`.                                                                                                                                                                                                                         |
| `PATCH /org/staff/{id}`                 | Body `{ status?: active or suspended, service_ids? }`. Staff `status`: `active`, `suspended`, `pending_verification`.                                                                                                                                                     |
| `PUT /org/staff/{id}/service-areas`     | Body `{ area_ids }`.                                                                                                                                                                                                                                                      |
| `GET /org/bookings`                     | Filters `status`, `date`, `staff_id`, `branch_id`. Items carry `assignment_deadline`, `staff`, `offer`, `patient`, `address`, `clinic: { id, name }` (the branch; `null` for home visits) and `allowed_actions` (`assign`, `broadcast`, `reassign`, `decline`, `cancel`). |
| `POST /org/bookings/{id}/broadcast`     | Returns `{ offered }`.                                                                                                                                                                                                                                                    |
| `POST /org/bookings/{id}/decline`       | `reason_code`: `no_staff_available`, `not_in_area`, `other`. Returns `{ status, passed_on }`.                                                                                                                                                                             |
| `POST /org/bookings/{id}/cancel`        | `reason_code`: `staff_unavailable`, `emergency`, `patient_request`, `other`.                                                                                                                                                                                              |
| `GET /org/bookings/{id}/eligible-staff` | Items: `{ id, name, gender, rating_avg, available, reason }`.                                                                                                                                                                                                             |
| `GET /org/dashboard`                    | `alerts[].type`: `unassigned_booking`, `offers_available`, `commission_limit`.                                                                                                                                                                                            |
| `GET /org/reports`                      | `group_by` adds `branch`. Rows: `{ key, label, visits, revenue, rating, on_time_rate }`.                                                                                                                                                                                  |
| `GET /org/invoices`                     | These are monthly statements (`kind: "statement"`), not tax invoices. `…/pdf` returns `{ url, expires_in }`.                                                                                                                                                              |
| `GET /org/subscription`                 | `{ plan, period, usage: { staff, pending_invites, max_staff }, unpaid: { amount, since } }`. `POST` body `{ plan_id }`.                                                                                                                                                   |

### Chat

- `GET /bookings/{id}/messages?before=<message id>&limit=30` (max 100), optional `conversation_id`.
  `meta` is `{ next_before, can_send, conversation_id }`.
- Message: `{ id, conversation_id, booking_id, sender_id, sender_role, body, attachment: { file_url, mime } | null, read_at, created_at }`.
- `GET /conversations` items add `closed` and `can_send`.
- `POST …/messages/read` returns `{ read }`.

### Notifications

- `POST /notifications/read` returns `{ updated, unread }`.
- The list keeps 180 days.

### Payments, packages, promo codes

- `POST /payments/initiate`: `method` is optional.
- Payment: `{ id, booking_id, package_subscription_id, purpose, amount, currency, method, status, checkout_url, expires_at, paid_at, refunded_amount, instrument: { brand, last4 }, failure_reason, created_at }`.
  `purpose`: `booking`, `package`, `commission`, `plan_fee`. `status`: `pending`, `paid`, `failed`,
  `expired`, `partially_refunded`, `refunded`. This is not the same list as a booking's `payment_status`.
- Packages add `visit_type`, `per_visit_value`, `organization`, `travel_fee_included: false`,
  `travel_fee_note`. Subscribing is by card or wallet only.
- Subscription: `status` (`pending_payment`, `active`, `used_up`, `expired`, `cancelled`), `visits_total`,
  `visits_remaining`, `visits_booked`.
- `POST /promo-codes/validate` takes an optional `visit_type`.

### Admin panel

| Endpoint                                      | Change                                                                                                                                                                                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /admin/documents/{id}/review`           | Body `{ status: matching or not_matching, note?, expires_at? }`.                                                                                                                                                                      |
| `POST /admin/users/{id}/suspend`              | `duration_days` must be sent (`null` = no end date). Returns `{ ends_at, cancelled_bookings }`.                                                                                                                                       |
| Users                                         | Add `admin_role` and `is_test_account`; detail adds `cancellation_record`.                                                                                                                                                            |
| `PATCH /admin/providers/{id}`                 | Body `{ verification_status?: approved or suspended, admin_message? }`.                                                                                                                                                               |
| `POST / PATCH /admin/admins`                  | Create: `{ phone, full_name, admin_role }`. Update: `{ status?, admin_role? }`.                                                                                                                                                       |
| `POST /admin/bookings/{id}/status`            | `status`: `cancelled`, `no_show`, `completed` only.                                                                                                                                                                                   |
| `GET /admin/bookings`, `GET /admin/analytics` | Filter `visit_type`.                                                                                                                                                                                                                  |
| `GET /admin/analytics`                        | `metric`: `bookings`, `completed_visits`, `gmv`, `revenue`, `cancellation_rate`, `active_providers`, `new_patients`, `new_providers`, `new_organizations`. `group_by`: `day` (max 92 days), `week`, `month`. Weeks start on Saturday. |
| `GET /admin/attention`                        | `{ expired_requests, open_disputes, expiring_documents, clinic_visits_not_started }`.                                                                                                                                                 |
| `POST /admin/disputes/{id}/resolve`           | Adds `refund_bearer` (`provider`, `platform`, `split`) and `provider_share`.                                                                                                                                                          |
| `POST /admin/notifications/broadcast`         | Adds `type` (`marketing` or `announcement`), `reason`, `dry_run`. Answers `202`, or an audience count for a dry run.                                                                                                                  |
| `POST /admin/ledger/adjustment`               | `owner_type`: `provider`, `organization`, `patient`.                                                                                                                                                                                  |
| `GET /admin/reports/export`                   | Returns `{ data: "<csv text>" }`.                                                                                                                                                                                                     |
| `PUT /admin/settings`                         | Send only the keys you change. Nothing is saved if one key is invalid.                                                                                                                                                                |
| Verification routes                           | Take a provider id or an organization id.                                                                                                                                                                                             |

**Admin roles.** `admin_role`: `super_admin`, `verifier`, `support`, `finance`, `marketing` (`null` =
super admin). A route the role may not use answers `403 FORBIDDEN`; hide those menu items. Booking notes
and dispute descriptions come back as `null` for every role except super admin and support.

---

## 4. Endpoints added to the spec

### Everyone

| Endpoint                                       | Purpose                                                                                         |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `GET /specialties`                             | Doctor specialties `[{ key, name }]`. Public.                                                   |
| `GET /consent-documents?role=`                 | Current terms, privacy and health-data texts with their versions. Public.                       |
| `GET /me/consents`                             | Per text: `current_version`, `accepted_version`, `accepted_at`, `withdrawn_at`, `up_to_date`.   |
| `POST /me/consents`                            | Body `{ consents: [{ kind, version, accepted }] }`. `accepted: false` withdraws.                |
| `GET /payments/{id}/return`                    | Where the payment page sends the user back; redirects to `reaya://payment-result?payment_id=…`. |
| `GET /api/v1/account-deletion`                 | Web page to delete an account without the app (store requirement). Nothing to build.            |
| `GET /health`, `/health/ready`, `/health/jobs` | Server checks.                                                                                  |

### Provider app

| Endpoint                                                                   | Purpose                                                                                                                |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `GET /provider/payout-method`                                              | The saved method, masked; `null` until set.                                                                            |
| `POST /provider/commission/pay`                                            | Pay cash commission owed. Body `{ amount?, method }` → `{ payment_id, checkout_url, amount, expires_at }`.             |
| `GET /provider/staff-invites`, `POST …/{id}/accept`, `POST …/{id}/decline` | An independent provider joining an organization.                                                                       |
| `GET / POST /provider/clinics`, `PATCH / DELETE /provider/clinics/{id}`    | A doctor's clinics.                                                                                                    |
| `PUT /provider/clinics/{id}/licence`, `POST …/submit`, `PUT …/schedule`    | Licence file, send for review, hours at the clinic. Deleting a clinic answers `409` while it has appointments to come. |

### Organization owner

| Endpoint                                                                                          | Purpose                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DELETE /org/documents/{id}`                                                                      | Remove a document.                                                                                                                                                                                                 |
| `GET /org/offers`                                                                                 | Requests offered to the organization after someone else did not answer.                                                                                                                                            |
| `GET /org/payout-method`                                                                          | The saved method, masked.                                                                                                                                                                                          |
| `POST /org/commission/pay`, `POST /org/subscription/pay`                                          | Pay commission owed or the plan fee.                                                                                                                                                                               |
| `GET / POST /org/branches`, `PATCH / DELETE /org/branches/{id}`, `PUT …/licence`, `POST …/submit` | Clinic branches.                                                                                                                                                                                                   |
| `PUT / DELETE /org/branches/{id}/doctors/{staffId}`                                               | Place a staff doctor at a branch (`{ slot_minutes, hours }`), or take them off. Taking a doctor off, or deleting a branch, answers `409` while appointments are still to come there (the message gives the count). |
| `POST / GET /org/branches/{id}/reception`, `DELETE …/reception/{userId}`                          | Reception staff of a branch.                                                                                                                                                                                       |

### Reception app (new role)

| Endpoint                                     | Purpose                                             |
| -------------------------------------------- | --------------------------------------------------- |
| `GET /reception/appointments`                | Today's appointments at the branch.                 |
| `POST /reception/appointments/{id}/check-in` | Body `{ visit_code }` or `{ without_code_reason }`. |
| `POST /reception/appointments/{id}/no-show`  | Mark a patient who did not come.                    |

### Admin panel

| Endpoint                                                                                           | Purpose                                         |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `GET /admin/bookings/{id}/conversations`                                                           | All chats of a booking.                         |
| `POST /admin/payouts/{id}/cancel`                                                                  | Body `{ reason }`.                              |
| `PATCH /admin/packages/{id}`, `PATCH /admin/subscription-plans/{id}`                               | Edit a package or a plan.                       |
| `GET /admin/notifications/broadcasts`                                                              | Broadcast history.                              |
| `GET / POST /admin/consent-documents`                                                              | Consent texts; publishing is for super admins.  |
| `GET /admin/clinics`, `GET /admin/clinics/{id}`, `POST …/approve`, `…/request-changes`, `…/reject` | Clinic review. The last two take `{ message }`. |

---

## 5. Enums

Values marked **NEW** are not in the spec.

| Enum                                              | Values                                                                                                                                                                                                                                                              |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User role                                         | `patient`, `provider`, `provider_staff`, `owner`, `admin`, **NEW** `reception`                                                                                                                                                                                      |
| Admin role                                        | `super_admin`, `verifier`, `support`, `finance`, **NEW** `marketing`                                                                                                                                                                                                |
| Verification status (providers and organizations) | `draft`, `pending`, `changes_requested`, `approved`, `rejected`, `suspended`                                                                                                                                                                                        |
| Booking status                                    | **NEW** `awaiting_payment`, `pending`, `accepted`, `declined`, `expired`, `on_the_way`, `in_progress`, `completed`, `cancelled`, `no_show`, `disputed`                                                                                                              |
| Booking type / `visit_type`                       | `home_visit`, **NEW** `clinic_visit` (`video` exists but is refused)                                                                                                                                                                                                |
| Payment method                                    | `cash`, `card`, `wallet`, **NEW** `covered`                                                                                                                                                                                                                         |
| Booking `payment_status`                          | `unpaid`, `pending`, `paid`, `refunded`, `failed`                                                                                                                                                                                                                   |
| Payment `status`                                  | `pending`, `paid`, `failed`, `expired`, `partially_refunded`, `refunded`                                                                                                                                                                                            |
| Payment `purpose`                                 | `booking`, `package`, **NEW** `commission`, `plan_fee`                                                                                                                                                                                                              |
| Clinic status                                     | **NEW** `draft`, `pending`, `approved`, `changes_requested`, `rejected`                                                                                                                                                                                             |
| Consent kind                                      | **NEW** `terms`, `privacy`, `health_data`                                                                                                                                                                                                                           |
| Notification type                                 | `booking_request`, `booking_offer`, `assignment_deadline_warning`, `booking_status`, `booking_reminder`, `chat_message`, `visit_report`, `review_request`, `verification_result`, `payout`, `package_expiry`, `promo`, **NEW** `account`, `dispute`, `announcement` |
| Document review status                            | `pending`, `matching`, `not_matching`                                                                                                                                                                                                                               |
| Payout status                                     | `pending`, `approved`, `paid`, **NEW** `cancelled`                                                                                                                                                                                                                  |
| Package subscription status                       | `pending_payment`, `active`, `used_up`, `expired`, `cancelled`                                                                                                                                                                                                      |
| Staff invite                                      | status `pending`, `accepted`, `declined`, `revoked`; kind `staff`, `reception`                                                                                                                                                                                      |
| Dispute                                           | status `open`, `resolved`; resolution `refund`, `partial_refund`, `no_action`                                                                                                                                                                                       |
| Banner action                                     | `none`, `promo`, `service`, `category`, `package`, `url`                                                                                                                                                                                                            |
| Broadcast type                                    | `marketing`, `announcement`                                                                                                                                                                                                                                         |

Unchanged from the spec: gender, preferred gender, provider type, assignment mode, pricing unit, relation,
document types, organization type, promo type.

---

## 6. Error codes

| Code                             | HTTP |     | Code                                    | HTTP |
| -------------------------------- | ---- | --- | --------------------------------------- | ---- |
| `VALIDATION_ERROR`               | 422  |     | `SLOT_UNAVAILABLE`                      | 409  |
| `UNAUTHENTICATED`                | 401  |     | `OFFER_TAKEN`                           | 409  |
| `TOKEN_EXPIRED`                  | 401  |     | `ASSIGNMENT_DEADLINE_PASSED`            | 409  |
| `FORBIDDEN`                      | 403  |     | `INVALID_STATUS_TRANSITION`             | 409  |
| `NOT_FOUND`                      | 404  |     | `CANCELLATION_NOT_ALLOWED`              | 409  |
| `RATE_LIMITED`                   | 429  |     | `ALREADY_REVIEWED`                      | 409  |
| `OTP_INVALID`                    | 400  |     | `AREA_NOT_COVERED`                      | 422  |
| `OTP_EXPIRED`                    | 400  |     | `PROMO_INVALID`                         | 422  |
| `OTP_MAX_ATTEMPTS`               | 429  |     | `PROMO_EXPIRED`                         | 422  |
| `ACCOUNT_SUSPENDED`              | 403  |     | `PROMO_LIMIT_REACHED`                   | 422  |
| `PROVIDER_NOT_VERIFIED`          | 403  |     | `PACKAGE_NO_VISITS_LEFT`                | 422  |
| `PAYMENT_FAILED`                 | 400  |     | `PACKAGE_EXPIRED`                       | 422  |
| **NEW** `BAD_REQUEST`            | 400  |     | **NEW** `CONFLICT`                      | 409  |
| **NEW** `IDEMPOTENCY_KEY_REUSED` | 422  |     | **NEW** `HEALTH_DATA_CONSENT_WITHDRAWN` | 403  |
| **NEW** `INTERNAL_ERROR`         | 500  |     | **NEW** `SERVICE_UNAVAILABLE`           | 503  |

Several refusals use a general code (`CONFLICT`, `BAD_REQUEST`, `FORBIDDEN`) with a specific Arabic
message: cash not available for this provider, clinic appointment limits, the plan's staff limit, a
duplicate record. For these, show `error.message`.

---

## 7. Realtime and push

### Socket.IO

- Connect to the server root with `auth: { token: <access_token> }`. A failed connection reports
  `UNAUTHENTICATED` or `TOKEN_EXPIRED`; refresh, then reconnect.
- The socket joins `user:<id>` by itself.
- To follow one booking: emit `booking:subscribe` with `{ booking_id }`; the acknowledgement is
  `{ ok: true | false }`. Leave with `booking:unsubscribe`.

| Event                         | Payload                               | Sent to                                                 |
| ----------------------------- | ------------------------------------- | ------------------------------------------------------- |
| `booking.status_changed`      | `{ event, booking_id, from, to, at }` | Patient, provider, organization owner, the booking room |
| `booking.new_request`         | `{ event, booking_id }`               | Provider or owner: a new request, offer or assignment   |
| **NEW** `booking.offer_taken` | `{ event, booking_id }`               | Providers whose offer was taken by someone else         |
| `message.new`                 | `{ event, booking_id, message }`      | Both sides of the chat                                  |
| `message.read`                | `{ event, booking_id, … }`            | The sender                                              |
| `notification.new`            | `{ id, type, title, body, data }`     | The user                                                |

Treat an event as "something changed" and load the object again with the REST endpoint.

### Push (FCM)

- Register the device with `POST /me/devices`.
- `data` holds strings only: always `type`, plus `notification_id` (not on chat pushes), and, depending on
  the notification, `booking_id`, `status`, `payment_id`, `invite_id`, `organization_id`, `document_id`,
  `broadcast_id`, `action`. Use `type` and the ids to open the right screen. `action: "choose_again"`
  means "open search again".
- Chat pushes never include the message text, and are not sent while the user has that chat open.
- `PUT /me/notification-settings` silences push only; the in-app list keeps everything.
  `reminders` → `booking_reminder`, `promotions` → `promo`, `chat` → `chat_message`. Every other type is
  always pushed.

---

## 8. Behaviour that changes screens

### Booking a provider

- A provider has 3 minutes (`direct_request_response_minutes`) to answer a direct request. If there is no
  answer and the patient allowed it, the request is offered to other providers and organizations at the
  same price for 20 minutes, then it expires. The first to accept wins; the others get `409 OFFER_TAKEN`.
- Preferred gender is a strict filter.
- The travel fee is shown separately (`price.travel_fee`).
- Patient contact details and the full address reach the provider only after acceptance; the provider's
  phone reaches the patient only after acceptance.
- The visit report can be edited for 24 hours. One review per completed booking.

### Card and wallet payment (flag `card_payment`)

1. `POST /bookings` → status `awaiting_payment` and `payment_action.checkout_url`.
2. Open the checkout page. The user returns to the app through `reaya://payment-result?payment_id=…`.
3. Ask `GET /payments/{id}` until `status` is `paid` or `failed`; the booking then moves to `pending`.
4. Not paid within 15 minutes → the booking becomes `expired`.

A paid booking that ends without a visit is refunded in full, except the fee below.

### Cancellation

- Free until the visit starts. If the patient cancels after the provider is on the way, or does not show
  up, the travel fee is charged: kept from the refund for card payments.
- Rescheduling is still limited to outside the free window (`cancellation_free_window_hours`).

### Cash and the commission limit

- A provider who owes 1,000 EGP in cash commission gets no new cash bookings. The quote says
  `cash_available: false`; hide cash for that booking.
- The provider sees `commission_limit { max, warning, over_limit }` in earnings (warning from 80%) and
  pays through `POST /provider/commission/pay`.
- Payouts are weekly, for the whole balance.

### Packages, promo codes, credit, referrals

- A package covers the visit price; the patient pays the travel fee each visit. Only providers priced at
  or under `per_visit_value` can be booked with it: search with `GET /providers?package_id=`.
- A package and a promo code cannot be combined.
- Referral: both sides get 50 EGP after the referred patient's first completed visit. Patient credit is
  used automatically on the next bookings (`discounts.credit`; balance in `GET /me/referral`).
- When the total reaches 0 the quote says `payment_required: false`.

### Organizations

- A booking made with an `organization_id` goes to the owner's queue with an `assignment_deadline`
  (25 minutes; a warning 10 minutes before). The owner assigns a staff member or sends it to all staff.
  After the deadline: `409 ASSIGNMENT_DEADLINE_PASSED`.
- Owner screens never show booking notes, medical data or visit reports. Patient name, phone and address
  appear once a staff member is assigned.
- Staff: invited by SMS (valid 7 days). A new number signs up with `role: provider_staff` and
  `staff_invite_id`. An existing independent provider accepts in the app, only with no active bookings, a
  zero balance and no open payout.
- Plans: the default plan is free. Over the plan's `max_staff`, new invites are refused. An unpaid plan
  fee leads to a notice after 14 days and a downgrade after 21.

### Consent and health data

- Until a consent text is published, nothing is asked. After that, sign-up must send the current
  versions, and `GET /me/consents` shows `up_to_date: false` when a newer version exists: ask the user to
  accept again.
- A patient who withdraws the `health_data` consent keeps the account and can still book, but:
  - saving medical data answers `403 HEALTH_DATA_CONSENT_WITHDRAWN` (show its message);
  - the profile shows `health_data_paused: true` and `health_data_notice`;
  - providers get `medical_summary: null` and `medical_summary_withheld: true`.
    Accepting again restores everything.

### Clinic visits (flag `clinic_visits`)

Full details and per-app tables: `docs/MOBILE_CHANGES_CLINIC_VISITS.md`. In short: doctors only; search
with `visit_type=clinic_visit` by the clinic's area; quote with `clinic_id` and no address; usually
confirmed at once; the patient shows a 4-digit `visit_code` at the clinic; no "on the way"; limits on how
many clinic appointments one account can hold; organization branches and a reception role.

### Test numbers

Store reviewers and testers sign in with agreed test numbers and a fixed code. In production these
accounts only see and book test providers.

---

## 9. Not built or switched off

| Item                                                               | State                                                                                                   |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Video consultations                                                | Not built. `type: video` is refused; `video` in a booking is always `null`.                             |
| Insurance                                                          | Not built.                                                                                              |
| Emergency button logging (spec §6.9)                               | No endpoint. The app only dials `emergency_number` from `GET /app-config`.                              |
| English                                                            | Texts are not written; everything answers in Arabic.                                                    |
| Card payment, packages, clinic visits                              | Built, switched off by their flags until launch.                                                        |
| Doctor home visits                                                 | Built; the category is inactive until an admin turns it on.                                             |
| SMS and online payment providers                                   | Not connected yet. Development servers print the code in the server log; staging will use test numbers. |
| Refunds on cash bookings, uncollected travel fees on cash bookings | Recorded only; no money moves.                                                                          |
