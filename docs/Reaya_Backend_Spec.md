# Reaya+ (رعاية+) — Backend Technical Specification

> Version 2.2 — Full backend handoff incl. complete API reference and admin panel
> Changes in 2.2: admin panel alignment (request changes, warnings, timed suspensions, document expiry, payout batches, settings defaults). Changes in 2.1: Arabic-only launch, area travel fees, preferred provider gender, assignment deadline + fallback / broadcast offers, on-time metric (see §13)
> Status: Draft for review. Items marked **[TBD]** need a decision before implementation.

---

## 1. Product Summary

Reaya+ is a home-healthcare and telehealth platform for the Egyptian market (launch: Cairo, Giza, Alexandria). It connects **patients and their families** with **verified nurses and doctors** for home visits and video consultations, and gives **healthcare businesses** (nursing centers, clinics, labs, elderly-care companies) tools to manage staff and bookings.

Core principles the backend must support:

- **Trust:** every provider is verified (license + syndicate card) before they can receive bookings.
- **Price transparency:** the final price is calculated and shown before the booking is confirmed.
- **Privacy:** medical data is sensitive and must be protected by design.

### Language: Arabic only at launch

The first release is **Arabic only (RTL)**. No English UI is required now. Keep the backend i18n-ready so English can be added later without schema changes: keep `name_en` columns nullable, and keep all user-facing strings (errors, notifications, SMS) in translation files rather than hard-coded.

### ⚠️ Hard constraint: NO location tracking

The app has **no maps, no GPS, no live tracking, no distance calculations**.

- Addresses are stored as **structured text** only.
- Provider coverage is a list of **selected areas**, not a radius.
- Matching and filtering are done by **area**, not distance.
- Do not collect, store, or process device location data in any form.

---

## 2. User Roles

| Role | Description | Platform |
|---|---|---|
| `patient` | Patient or family member booking care. Can manage multiple family profiles. | Mobile |
| `provider` | Independent nurse or doctor. | Mobile |
| `provider_staff` | Nurse/doctor employed by a service owner (same capabilities as provider, but bookings assigned by the owner and earnings go to the organization). | Mobile |
| `owner` | Service owner (center / clinic / company) managing a team. | Mobile + Web dashboard |
| `admin` | Internal Reaya+ team: verification, disputes, config, reports. | Web admin panel |

A single user account has exactly one role. **[TBD]** whether one phone number can hold multiple roles.

---

## 3. Suggested Tech Stack

Proposals, open to the team's judgment:

- **API:** Node.js (NestJS) or Laravel — REST + JSON, versioned under `/api/v1`
- **Database:** PostgreSQL
- **Cache / queues:** Redis (OTP rate limiting, job queues, sessions)
- **File storage:** S3-compatible object storage, private buckets, signed URLs
- **Push notifications:** Firebase Cloud Messaging
- **SMS / OTP:** local SMS provider **[TBD]**
- **Payments:** local gateway, e.g. Paymob or Fawry **[TBD]**
- **Real-time (chat & status updates):** WebSockets (Socket.IO) or Firebase **[TBD]**
- **Video consultations (Phase 2):** third-party SDK (e.g. Agora / Twilio / Daily) **[TBD]**
- **Docs:** OpenAPI / Swagger generated from code

---

## 4. Core Domain Model

Below are the main entities. Field lists are the minimum; add timestamps (`created_at`, `updated_at`) and soft delete (`deleted_at`) to all tables.

### 4.1 Users & Auth

**users**
- `id` (uuid), `phone` (unique, E.164), `email` (nullable), `full_name`, `gender`, `date_of_birth`
- `role` (enum: patient, provider, provider_staff, owner, admin)
- `language` (ar / en, default ar), `avatar_url`
- `status` (active, suspended, deleted)
- `last_login_at`

**otp_codes** — `phone`, `code_hash`, `expires_at`, `attempts`, `consumed_at`

**devices** — `user_id`, `fcm_token`, `platform` (ios/android/web), `last_seen_at`

### 4.2 Locations (text only)

**governorates** — `id`, `name_ar`, `name_en`
**areas** — `id`, `governorate_id`, `name_ar`, `name_en`, `is_active`, `max_travel_fee` (piastres, nullable — admin cap; providers/orgs cannot set a higher travel fee in this area)

Seeded and managed by admin. Only active areas are bookable.

**addresses**
- `id`, `user_id`, `label` (Home, Dad's house, ...)
- `governorate_id`, `area_id`, `street`, `building`, `floor`, `apartment`, `landmark`, `notes`
- `is_default`
- No latitude / longitude columns.

### 4.3 Patients & Medical Profile

**patient_profiles** (a user can own several: self + family members)
- `id`, `owner_user_id`, `full_name`, `relation` (self, father, mother, child, spouse, other)
- `gender`, `date_of_birth`, `blood_type` (nullable)

**medical_conditions** — `patient_profile_id`, `name`, `notes`
**medications** — `patient_profile_id`, `name`, `dosage`, `frequency`, `notes`
**allergies** — `patient_profile_id`, `name`, `severity`
**medical_documents** — `patient_profile_id`, `type` (prescription, lab_result, report, other), `file_key`, `uploaded_by`

### 4.4 Providers & Organizations

**organizations** (service owners)
- `id`, `owner_user_id`, `name`, `type` (nursing_center, clinic, lab, elderly_care, other)
- `commercial_register_no`, `tax_id`, `logo_url`, `description`
- `verification_status` (pending, approved, rejected), `subscription_plan_id`

**provider_profiles**
- `id`, `user_id`, `organization_id` (nullable — null means independent)
- `type` (nurse, doctor), `specialty` (for doctors), `years_of_experience`, `bio`
- `license_number`, `syndicate_number`
- `verification_status` (draft, pending, changes_requested, approved, rejected, suspended), `rejection_reason`, `admin_message`
- `rating_avg`, `rating_count`, `completed_visits_count` (denormalized)
- `is_accepting_bookings`

**provider_documents** — `provider_profile_id`, `type` (license, syndicate_card, national_id_front, national_id_back, certificate), `file_key`, `status` (pending, matching, not_matching), `expires_at` (nullable — license / syndicate card expiry), `reviewed_by`, `reviewed_at`, `review_note`
> A daily job flags documents expiring within 30 days (admin "needs attention" + provider notification) and auto-pauses bookings for providers whose license has expired **[TBD]**.

**provider_service_areas** — `provider_profile_id`, `area_id`, `travel_fee` (piastres, default 0)

**organization_service_areas** — `organization_id`, `area_id`, `travel_fee` (piastres, default 0), `is_active`
> Area travel fee: a fixed fee per neighbourhood, set by the provider or organization, added to every home-visit booking in that area. The owner's "Area fees" tab also shows **team size per area** = count of active staff covering that area (computed, not stored).

**provider_availability** — weekly recurring slots: `provider_profile_id`, `day_of_week`, `start_time`, `end_time`
**provider_time_off** — `provider_profile_id`, `starts_at`, `ends_at`, `reason`

### 4.5 Services & Pricing

**service_categories** — nursing, doctor_home_visit, video_consultation, elderly_care, packages

**services** (admin-defined catalog)
- `id`, `category_id`, `name_ar`, `name_en`, `description`
- `provider_type` (nurse / doctor), `pricing_unit` (per_visit, per_hour, per_day)
- `default_duration_minutes`

**provider_services** — `provider_profile_id` or `organization_id`, `service_id`, `price`, `is_active`
(Providers set their own price per service. **[TBD]** admin min/max price bounds.)

### 4.6 Bookings

**bookings**
- `id`, `reference_code` (human-readable, e.g. RY-24A7K3)
- `patient_user_id`, `patient_profile_id`, `address_id` (snapshot address text into the booking too)
- `service_id`, `provider_profile_id` (nullable until assigned), `organization_id` (nullable)
- `type` (home_visit, video)
- `scheduled_start`, `scheduled_end`, `quantity` (hours/days if applicable)
- `status` (see §5)
- `preferred_gender` (enum: any, male, female — default any)
- `assignment_mode` (enum: direct, organization, broadcast)
- `assignment_deadline` (timestamp — when the organization must assign by)
- `started_at`, `completed_at` (set when provider taps start / end), `is_on_time` (bool, computed at start)
- `patient_notes`, `cancellation_reason`, `cancelled_by`
- Pricing snapshot: `subtotal`, `travel_fee`, `discount`, `platform_fee`, `total`, `commission_rate`, `provider_payout`
- Commission is calculated on `subtotal` only; `travel_fee` goes 100% to the provider/organization **[TBD]**.

**booking_offers** (used when a request is sent to several providers)
- `id`, `booking_id`, `provider_profile_id`, `organization_id` (nullable)
- `status` (offered, accepted, declined, expired, lost — "lost" = someone else accepted first)
- `offered_at`, `responded_at`, `expires_at`
- `payment_method` (cash, card, wallet), `payment_status` (unpaid, pending, paid, refunded, failed)
- `package_subscription_id` (nullable)

**booking_status_history** — `booking_id`, `from_status`, `to_status`, `changed_by`, `note`, `created_at` (append-only audit log)

**visit_reports** (written by provider after visit)
- `booking_id`, `provider_profile_id`, `summary`, `vitals` (JSON: BP, pulse, temp, sugar, SpO2), `procedures_done`, `recommendations`, `attachments`
- Automatically linked to the patient's medical profile.

**reviews** — `booking_id` (unique), `patient_user_id`, `provider_profile_id`, `rating` (1–5), `comment`, `is_visible`

### 4.7 Packages & Subscriptions

**packages** — `id`, `organization_id` or `provider_profile_id` or platform, `name`, `service_id`, `visits_count`, `validity_days`, `price`
**package_subscriptions** — `id`, `package_id`, `patient_user_id`, `patient_profile_id`, `visits_remaining`, `starts_at`, `expires_at`, `status`

**subscription_plans** (for organizations) — `name`, `monthly_price`, `max_staff`, `features` (JSON)

### 4.8 Payments & Payouts

**payments** — `booking_id` or `package_subscription_id`, `amount`, `method`, `gateway`, `gateway_ref`, `status`, `raw_response` (JSON)
**refunds** — `payment_id`, `amount`, `reason`, `status`
**wallet_ledger** (provider / organization earnings) — `owner_type`, `owner_id`, `booking_id`, `type` (credit, debit, payout, adjustment, commission_due), `amount`, `balance_after`
**payouts** — `owner_type`, `owner_id`, `amount`, `method`, `status`, `reference`

> Cash bookings: the provider collects the full amount, so the platform commission becomes a **debit** on the provider's ledger to be settled. Card/wallet bookings: platform collects, then credits the provider's share.

### 4.9 Communication

**conversations** — one per booking: `booking_id`, participants
**messages** — `conversation_id`, `sender_id`, `body`, `attachment_key`, `read_at`
**notifications** — `user_id`, `type`, `title`, `body`, `data` (JSON), `read_at`

### 4.10 Platform

**promo_codes** — `code`, `type` (percent, fixed), `value`, `max_uses`, `per_user_limit`, `valid_from`, `valid_to`
**referrals** — `referrer_user_id`, `referred_user_id`, `reward_status`
> Reward: **50 EGP credit to each side** (setting `referral_reward` = 5000), granted after the referred user completes their first booking.

**user_suspensions** — `user_id`, `reason`, `starts_at`, `ends_at` (nullable = indefinite), `created_by`, `lifted_at`
**user_warnings** — `user_id`, `reason`, `related_type` (booking, dispute, review), `related_id`, `created_by`
**settings** — key/value config (commission rate, cancellation window, etc.)
**audit_logs** — `actor_id`, `action`, `entity_type`, `entity_id`, `metadata`, `ip`

---

## 5. Booking Status Flow

```
pending ──► accepted ──► on_the_way ──► in_progress ──► completed
   │            │             │               
   │            └──► cancelled ◄┘               
   ├──► declined (provider)      
   ├──► expired (no response within X minutes)
   └──► cancelled (patient)
                          completed ──► disputed (optional)
```

| Status | Set by | Notes |
|---|---|---|
| `pending` | system | Created by patient; waiting for provider/owner. |
| `accepted` | provider / owner | Owner may assign to a staff member first. |
| `declined` | provider | Patient notified; suggest alternatives. |
| `expired` | system (job) | Nobody accepted: after the organization deadline **and** the fallback broadcast window both ran out (see §6.10). |
| `on_the_way` | provider | **Manual button** in provider app. No location data. |
| `in_progress` | provider | Manual "Start visit". |
| `completed` | provider | Manual "End visit"; prompts visit report. Triggers review request + ledger entries. |
| `cancelled` | patient / provider / admin | Cancellation fee rules **[TBD]**. |
| `no_show` | provider / admin | Patient not available. |
| `disputed` | patient / admin | Opened within X hours after completion. |

Rules:
- Every transition is validated server-side (state machine) and written to `booking_status_history`.
- Every transition fires a push notification + real-time event to the other party.
- Video bookings skip `on_the_way`.

---

## 6. Key Business Logic

1. **Provider search / matching**
   Filter providers where: `verification_status = approved` AND `is_accepting_bookings = true` AND the booking's `area_id` ∈ provider service areas AND provider offers the service AND the requested slot fits availability and has no conflicting booking.
   Sort options: rating, price, experience. Filters: gender, price range, provider type, organization vs independent.

2. **Double-booking prevention** — lock / transaction check on the provider's schedule when a booking is accepted.

3. **Pricing** — computed server-side only: `price × quantity + travel_fee − discount (promo/package) + platform_fee` → `total`. Never trust client prices. Store a full price snapshot on the booking.

4. **Commission** — configurable (15–20%), overridable per organization/plan. `provider_payout = subtotal − commission`.

5. **Packages** — booking against a package decrements `visits_remaining` on completion (or on acceptance **[TBD]**); refund the visit on cancellation.

6. **Organization assignment** — bookings to an organization land in the owner's queue with `assignment_deadline = now + org_assign_deadline_minutes` (setting, default **25**). The owner either assigns one staff member, or taps **"send to all suitable"**, which creates `booking_offers` for every eligible staff member (right area, free slot, matching preferred gender); the **first to accept wins** and all other offers become `lost`. Accept must be atomic (row lock / conditional update) so two staff can never accept the same booking.

7. **Verification gate** — providers and organizations cannot appear in search or receive bookings until approved by admin.

8. **Reviews** — only after `completed`, one per booking. Recalculate `rating_avg` asynchronously.

9a. **Direct request response time** — a request sent directly to one independent provider must be answered within `direct_request_response_minutes` (setting, default **3**). If not answered, it moves to the same fallback broadcast as §10.

9. **Emergency button** — client-side only (dials ambulance 123). Backend just logs the tap event for analytics. **[TBD]**

10. **Assignment deadline fallback** — a background job checks bookings still unassigned at `assignment_deadline`. It then broadcasts the request as `booking_offers` to other eligible **independent providers and organizations** in the same area (first to accept wins), for `fallback_window_minutes` (setting `fallback_window_minutes`, default **20**). If still nobody accepts → `expired`, patient notified with suggestions. **[TBD]** whether the patient must agree to fallback when they chose a specific organization (suggest a checkbox at booking: "لو المركز مش متاح، ابعت لمقدمي خدمة تانيين" default on).

11. **Preferred gender** — the patient can choose any / male / female when booking. Search results, staff lists in the assign screen, and broadcast offers only include providers matching the preference (the assign screen may show non-matching staff greyed out). **[TBD]** whether it is a strict filter or a soft preference.

12. **Area travel fee** — when quoting a home visit, look up the travel fee of the chosen provider (`provider_service_areas`) or organization (`organization_service_areas`) for the booking's `area_id` and add it as a separate line. Video bookings have no travel fee.

13. **On-time metric** — at `start`, set `is_on_time = started_at <= scheduled_start + on_time_grace_minutes` (setting, default **15**). There is no GPS, so it relies on the provider's manual status update. Used in provider and staff performance reports ("on time %").

---

## 7. API Reference (`/api/v1`) — Full Endpoint List

### 7.0 Conventions

**Base URL:** `https://api.reaya.app/api/v1` (placeholder)

**Headers**
| Header | Value |
|---|---|
| `Authorization` | `Bearer <access_token>` (all endpoints except public ones) |
| `Accept-Language` | `ar` (only value supported at launch; `en` reserved for later) |
| `Content-Type` | `application/json` (or `multipart/form-data` for uploads) |
| `Idempotency-Key` | UUID — required on `POST /bookings`, `POST /payments/initiate`, `POST /packages/{id}/subscribe` |

**Success envelope**
```json
{ "data": { ... }, "meta": { ... } }
```

**Paginated list** — query `?page=1&per_page=20` (max 100)
```json
{
  "data": [ ... ],
  "meta": { "page": 1, "per_page": 20, "total": 134, "last_page": 7 }
}
```

**Error envelope**
```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Localized human-readable message",
    "fields": { "phone": ["Invalid phone number"] }
  }
}
```

**Common HTTP codes:** `200` OK, `201` Created, `204` No Content, `400` Bad request, `401` Unauthenticated, `403` Forbidden (wrong role / not owner), `404` Not found, `409` Conflict (state / slot taken), `422` Validation error, `429` Rate limited, `500` Server error.

**Global error codes**
| Code | Meaning |
|---|---|
| `VALIDATION_ERROR` | Invalid input (see `fields`) |
| `UNAUTHENTICATED` | Missing / invalid / expired token |
| `TOKEN_EXPIRED` | Access token expired — call refresh |
| `FORBIDDEN` | Role or ownership not allowed |
| `NOT_FOUND` | Resource not found |
| `RATE_LIMITED` | Too many requests |
| `OTP_INVALID` / `OTP_EXPIRED` / `OTP_MAX_ATTEMPTS` | OTP problems |
| `ACCOUNT_SUSPENDED` | User suspended |
| `PROVIDER_NOT_VERIFIED` | Provider action requires approval |
| `SLOT_UNAVAILABLE` | Requested time no longer available |
| `OFFER_TAKEN` | Another provider accepted this request first |
| `ASSIGNMENT_DEADLINE_PASSED` | Organization can no longer assign (request moved to fallback) |
| `AREA_NOT_COVERED` | No provider/service in that area |
| `INVALID_STATUS_TRANSITION` | Booking state change not allowed |
| `CANCELLATION_NOT_ALLOWED` | Outside cancellation window |
| `PROMO_INVALID` / `PROMO_EXPIRED` / `PROMO_LIMIT_REACHED` | Promo problems |
| `PACKAGE_NO_VISITS_LEFT` / `PACKAGE_EXPIRED` | Package problems |
| `PAYMENT_FAILED` | Gateway failure |
| `ALREADY_REVIEWED` | Review already submitted |

**Formats**
- IDs: UUID strings.
- Dates/times: ISO 8601 in UTC (`2026-10-05T14:00:00Z`). Client displays in `Africa/Cairo`.
- Money: integer **piastres** (`35000` = 350.00 EGP) + `currency: "EGP"`.
- Phone: E.164 (`+201001234567`).

**Enums (shared with frontend)**
```
role:                patient | provider | provider_staff | owner | admin
gender:              male | female
provider_type:       nurse | doctor
verification_status: draft | pending | changes_requested | approved | rejected | suspended
booking_type:        home_visit | video
preferred_gender:    any | male | female
assignment_mode:     direct | organization | broadcast
offer_status:        offered | accepted | declined | expired | lost
booking_status:      pending | accepted | declined | expired | on_the_way |
                     in_progress | completed | cancelled | no_show | disputed
payment_method:      cash | card | wallet
payment_status:      unpaid | pending | paid | refunded | failed
pricing_unit:        per_visit | per_hour | per_day
relation:            self | father | mother | child | spouse | sibling | other
document_type:       license | syndicate_card | national_id_front |
                     national_id_back | certificate | commercial_register | tax_card
medical_doc_type:    prescription | lab_result | report | other
```

**Endpoint count summary**
| Group | Endpoints |
|---|---|
| Auth | 7 |
| Me / Account | 7 |
| Lookups | 7 |
| Uploads | 1 |
| Patient — Addresses | 5 |
| Patient — Profiles & Medical | 22 |
| Patient — Discovery | 5 |
| Patient — Bookings | 9 |
| Patient — Packages & Promos | 5 |
| Provider | 35 |
| Owner (Organization) | 40 |
| Chat | 4 |
| Notifications | 4 |
| Payments | 4 |
| Admin | 65 |
| **Total** | **~225** |

---

### 7.1 Auth (public)

#### `POST /auth/otp/request`
Send OTP via SMS. Rate limit: 3 per phone / 10 min, 10 per IP / hour.
```json
// body
{ "phone": "+201001234567" }
// 200
{ "data": { "expires_in": 120, "resend_after": 60 } }
```

#### `POST /auth/otp/verify`
```json
// body
{ "phone": "+201001234567", "code": "4821" }
// 200 — existing user
{ "data": {
  "is_new_user": false,
  "access_token": "eyJ...", "refresh_token": "eyJ...", "expires_in": 3600,
  "user": { "id": "u_1", "full_name": "أحمد محمود", "role": "patient", "language": "ar" }
}}
// 200 — new user (short-lived registration token, no role yet)
{ "data": { "is_new_user": true, "registration_token": "reg_..." } }
```

#### `POST /auth/register`
Header: `Authorization: Bearer <registration_token>`
```json
// body
{
  "role": "patient",                 // patient | provider | owner
  "full_name": "أحمد محمود",
  "gender": "male",
  "date_of_birth": "1985-03-12",
  "email": "ahmed@mail.com",         // optional
  "language": "ar",
  "referral_code": "AHMED25"         // optional
}
// 201
{ "data": { "access_token": "...", "refresh_token": "...", "expires_in": 3600, "user": { ... } } }
```
Side effects: patient → auto-creates `patient_profile` with `relation=self`. provider → creates `provider_profile` with `verification_status=draft`. owner → requires `POST /org` next.

#### `POST /auth/refresh`
```json
{ "refresh_token": "eyJ..." }
// 200
{ "data": { "access_token": "...", "refresh_token": "...", "expires_in": 3600 } }
```

#### `POST /auth/logout`
```json
{ "refresh_token": "eyJ...", "fcm_token": "optional" }
// 204
```

#### `POST /auth/phone/change/request` (auth)
```json
{ "new_phone": "+201112223334" }   // sends OTP to new phone
```

#### `POST /auth/phone/change/verify` (auth)
```json
{ "new_phone": "+201112223334", "code": "5512" }   // 200 → updated user
```

---

### 7.2 Me / Account (all roles)

| Method | Path | Description |
|---|---|---|
| `GET` | `/me` | Current user + role-specific summary |
| `PATCH` | `/me` | Update name, email, gender, DOB, language |
| `POST` | `/me/avatar` | Upload avatar (multipart `file`) |
| `POST` | `/me/devices` | Register / refresh FCM token |
| `DELETE` | `/me/devices/{fcm_token}` | Remove device |
| `GET` | `/me/referral` | Referral code + stats |
| `DELETE` | `/me` | Request account deletion |

#### `GET /me`
```json
{ "data": {
  "id": "u_1", "phone": "+201001234567", "full_name": "أحمد محمود",
  "email": null, "gender": "male", "date_of_birth": "1985-03-12",
  "role": "patient", "language": "ar", "avatar_url": "https://...",
  "status": "active",
  "provider_profile": null,         // object if provider / provider_staff
  "organization": null,             // object if owner
  "unread_notifications": 3
}}
```

#### `POST /me/devices`
```json
{ "fcm_token": "fcm_abc", "platform": "android", "app_version": "1.0.0" }
```

#### `GET /me/referral`
```json
{ "data": { "code": "AHMED25", "share_url": "https://reaya.app/r/AHMED25",
  "invited_count": 4, "rewards_earned": 20000 } }
```

#### `DELETE /me`
```json
{ "reason": "optional text" }   // 202 — scheduled; blocked if active bookings exist
```

---

### 7.3 Lookups (public, cacheable)

| Method | Path | Description |
|---|---|---|
| `GET` | `/governorates` | Active governorates |
| `GET` | `/governorates/{id}/areas` | Areas of a governorate |
| `GET` | `/areas?search=` | Search areas (for provider multi-select) |
| `GET` | `/service-categories` | Categories with icons |
| `GET` | `/services?category_id=&provider_type=` | Service catalog |
| `GET` | `/services/{id}` | Service details |
| `GET` | `/app-config` | Min app version, support phone, emergency number, cancellation policy text, feature flags |

#### `GET /governorates/{id}/areas`
```json
{ "data": [ { "id": "a_12", "name": "مدينة نصر", "governorate_id": "g_1" } ] }
```

#### `GET /services`
```json
{ "data": [ {
  "id": "s_3", "category_id": "c_nursing", "name": "غيار على جرح",
  "description": "...", "provider_type": "nurse",
  "pricing_unit": "per_visit", "default_duration_minutes": 45,
  "starting_price": 20000, "currency": "EGP"
} ] }
```

#### `GET /app-config`
```json
{ "data": {
  "min_app_version": { "android": "1.0.0", "ios": "1.0.0" },
  "support_phone": "+2016xxxx", "emergency_number": "123",
  "cancellation_free_window_hours": 3,
  "direct_request_response_minutes": 3,
  "features": { "video_consult": false, "card_payment": false, "packages": false }
}}
```

---

### 7.4 Uploads

#### `POST /uploads`
Generic private upload used by documents, chat attachments, visit reports. `multipart/form-data`: `file`, `purpose` (`provider_document | org_document | medical_document | chat | visit_report | avatar`). Max 10 MB; jpg, png, pdf.
```json
// 201
{ "data": { "file_key": "tmp/9f2c...", "mime": "image/jpeg", "size": 482133 } }
```
Returned `file_key` is then attached in the relevant endpoint. Files are always read through short-lived signed URLs returned inside resources (`file_url`, valid 10 min).

---

### 7.5 Patient — Addresses (role: patient)

| Method | Path | Description |
|---|---|---|
| `GET` | `/addresses` | List my addresses |
| `POST` | `/addresses` | Create |
| `PATCH` | `/addresses/{id}` | Update |
| `DELETE` | `/addresses/{id}` | Delete (blocked if used by an upcoming booking) |
| `POST` | `/addresses/{id}/default` | Set default |

#### `POST /addresses`
Text-only address. **No coordinates are accepted.**
```json
{
  "label": "بيت بابا",
  "governorate_id": "g_1", "area_id": "a_12",
  "street": "شارع عباس العقاد", "building": "15", "floor": "4", "apartment": "12",
  "landmark": "بجوار صيدلية العزبي", "notes": "الأسانسير عطلان",
  "is_default": true
}
// 201 → address object with id + governorate/area names
```

---

### 7.6 Patient — Profiles & Medical Records (role: patient)

| Method | Path | Description |
|---|---|---|
| `GET` | `/patient-profiles` | Me + family members |
| `POST` | `/patient-profiles` | Add family member |
| `GET` | `/patient-profiles/{id}` | Full profile incl. medical summary |
| `PATCH` | `/patient-profiles/{id}` | Update |
| `DELETE` | `/patient-profiles/{id}` | Delete (not `self`) |
| `GET/POST` | `/patient-profiles/{id}/conditions` | List / add chronic condition |
| `PATCH/DELETE` | `/patient-profiles/{id}/conditions/{cid}` | Update / delete |
| `GET/POST` | `/patient-profiles/{id}/medications` | List / add |
| `PATCH/DELETE` | `/patient-profiles/{id}/medications/{mid}` | Update / delete |
| `GET/POST` | `/patient-profiles/{id}/allergies` | List / add |
| `PATCH/DELETE` | `/patient-profiles/{id}/allergies/{aid}` | Update / delete |
| `GET/POST` | `/patient-profiles/{id}/documents` | List / attach uploaded file |
| `DELETE` | `/patient-profiles/{id}/documents/{did}` | Delete |
| `GET` | `/patient-profiles/{id}/visit-reports` | Reports written by providers |
| `GET` | `/patient-profiles/{id}/visit-reports/{rid}` | Report details |

#### `POST /patient-profiles`
```json
{ "full_name": "محمود علي", "relation": "father", "gender": "male",
  "date_of_birth": "1950-06-01", "blood_type": "A+" }
```

#### `GET /patient-profiles/{id}`
```json
{ "data": {
  "id": "pp_2", "full_name": "محمود علي", "relation": "father", "age": 76,
  "gender": "male", "blood_type": "A+",
  "conditions": [ { "id": "c1", "name": "سكر", "notes": "نوع ثاني" } ],
  "medications": [ { "id": "m1", "name": "Glucophage", "dosage": "1000mg", "frequency": "مرتين يومياً" } ],
  "allergies": [ { "id": "al1", "name": "بنسلين", "severity": "high" } ],
  "documents_count": 4, "visit_reports_count": 7
}}
```

#### `POST /patient-profiles/{id}/documents`
```json
{ "file_key": "tmp/9f2c...", "type": "prescription", "title": "روشتة د. سامي" }
```

#### `GET /patient-profiles/{id}/visit-reports/{rid}`
```json
{ "data": {
  "id": "vr_1", "booking_id": "b_1", "date": "2026-10-05T14:40:00Z",
  "provider": { "id": "p_1", "name": "منى حسن", "type": "nurse" },
  "summary": "تم تغيير الغيار، الجرح يلتئم بشكل جيد",
  "vitals": { "bp": "130/85", "pulse": 82, "temp": 37.1, "sugar": 145, "spo2": 97 },
  "procedures_done": ["غيار جرح", "قياس سكر"],
  "recommendations": "متابعة بعد يومين",
  "attachments": [ { "file_url": "https://signed...", "mime": "image/jpeg" } ]
}}
```

---

### 7.7 Patient — Discovery

| Method | Path | Description |
|---|---|---|
| `GET` | `/home` | Home screen payload |
| `GET` | `/providers` | Search providers |
| `GET` | `/providers/{id}` | Provider public profile |
| `GET` | `/providers/{id}/reviews` | Paginated reviews |
| `GET` | `/providers/{id}/slots` | Available time slots |

#### `GET /home`
```json
{ "data": {
  "greeting_name": "أحمد",
  "categories": [ { "id": "c_nursing", "name": "تمريض منزلي", "icon_url": "..." } ],
  "upcoming_booking": { "id": "b_1", "status": "accepted", "service_name": "غيار على جرح",
    "scheduled_start": "2026-10-05T14:00:00Z", "provider_name": "منى حسن" },
  "active_package": { "id": "ps_1", "name": "باقة رعاية المسنين", "visits_remaining": 5 },
  "banners": [ { "image_url": "...", "action": "promo", "value": "WELCOME20" } ]
}}
```

#### `GET /providers`
Query params:
| Param | Required | Notes |
|---|---|---|
| `service_id` | ✅ | |
| `area_id` | ✅ | From the selected address — **matching by area only** |
| `date` | ❌ | `YYYY-MM-DD`, only providers with free slots that day |
| `time` | ❌ | `HH:mm` |
| `gender` | ❌ | `male | female` — the patient's preferred provider gender |
| `provider_type` | ❌ | `nurse | doctor` |
| `min_price`, `max_price` | ❌ | piastres |
| `min_rating` | ❌ | 1–5 |
| `source` | ❌ | `independent | organization` |
| `sort` | ❌ | `rating` (default) \| `price_asc` \| `price_desc` \| `experience` |
| `page`, `per_page` | ❌ | |
```json
{ "data": [ {
  "id": "p_1", "name": "منى حسن", "avatar_url": "...", "type": "nurse", "gender": "female",
  "is_verified": true, "years_of_experience": 8,
  "rating_avg": 4.8, "rating_count": 213, "completed_visits": 540,
  "price": 25000, "currency": "EGP", "pricing_unit": "per_visit",
  "organization": null,
  "next_available": "2026-10-05T12:00:00Z"
} ], "meta": { ... } }
```

#### `GET /providers/{id}`
```json
{ "data": {
  "id": "p_1", "name": "منى حسن", "type": "nurse", "specialty": null,
  "bio": "...", "years_of_experience": 8, "is_verified": true,
  "rating_avg": 4.8, "rating_count": 213, "completed_visits": 540,
  "languages": ["ar", "en"],
  "service_areas": [ { "id": "a_12", "name": "مدينة نصر" } ],
  "services": [ { "service_id": "s_3", "name": "غيار على جرح", "price": 25000, "pricing_unit": "per_visit" } ],
  "organization": { "id": "o_1", "name": "مركز الشفاء للتمريض" },
  "recent_reviews": [ { "rating": 5, "comment": "ممتازة جداً", "patient_name": "أ. محمد", "date": "..." } ]
}}
```

#### `GET /providers/{id}/slots?service_id=&date=YYYY-MM-DD&quantity=`
```json
{ "data": { "date": "2026-10-05", "slots": [
  { "start": "2026-10-05T10:00:00Z", "end": "2026-10-05T10:45:00Z", "available": true },
  { "start": "2026-10-05T11:00:00Z", "end": "2026-10-05T11:45:00Z", "available": false }
]}}
```

---

### 7.8 Patient — Bookings

| Method | Path | Description |
|---|---|---|
| `POST` | `/bookings/quote` | Price breakdown before confirming |
| `POST` | `/bookings` | Create booking |
| `GET` | `/bookings?status=&scope=upcoming\|past` | My bookings |
| `GET` | `/bookings/{id}` | Booking details + status timeline |
| `POST` | `/bookings/{id}/cancel` | Cancel |
| `POST` | `/bookings/{id}/reschedule` | Request new time (goes back to `pending`) |
| `POST` | `/bookings/{id}/review` | Rate provider |
| `POST` | `/bookings/{id}/dispute` | Report a problem |
| `POST` | `/bookings/{id}/rebook` | Book same service/provider again (returns pre-filled quote) |

#### `POST /bookings/quote`
```json
// body
{
  "service_id": "s_3",
  "provider_id": "p_1",                    // OR organization_id (one of them)
  "organization_id": null,
  "patient_profile_id": "pp_2", "address_id": "ad_1",
  "type": "home_visit",
  "preferred_gender": "female",            // any | male | female
  "allow_fallback": true,                  // org bookings: send to others if not assigned in time
  "scheduled_start": "2026-10-05T14:00:00Z", "quantity": 1,
  "promo_code": "WELCOME20",               // optional
  "package_subscription_id": null          // optional
}
// 200
{ "data": {
  "subtotal": 25000, "travel_fee": 3000, "discount": 5000, "platform_fee": 0, "total": 23000, "currency": "EGP",
  "lines": [
    { "label": "غيار على جرح × 1", "amount": 25000 },
    { "label": "رسوم انتقال (مدينة نصر)", "amount": 3000 },
    { "label": "خصم WELCOME20", "amount": -5000 }
  ],
  "cancellation_policy": "إلغاء مجاني حتى 3 ساعات قبل الموعد",
  "quote_token": "q_7x..."     // valid 10 min, guarantees the price
}}
```

#### `POST /bookings` (header `Idempotency-Key`)
```json
// body
{ "quote_token": "q_7x...", "payment_method": "cash", "patient_notes": "المريض لا يستطيع الحركة" }
// 201
{ "data": {
  "id": "b_1", "reference_code": "RY-24A7K3", "status": "pending",
  "payment_method": "cash", "payment_status": "unpaid",
  "payment_action": null    // for card/wallet: { "checkout_url": "..." } → see /payments
}}
```
Errors: `SLOT_UNAVAILABLE` (409), `AREA_NOT_COVERED`, `PROMO_*`, `PACKAGE_*`.

#### `GET /bookings/{id}`
```json
{ "data": {
  "id": "b_1", "reference_code": "RY-24A7K3", "type": "home_visit", "status": "on_the_way",
  "service": { "id": "s_3", "name": "غيار على جرح" },
  "patient_profile": { "id": "pp_2", "full_name": "محمود علي" },
  "address": { "label": "بيت بابا", "full_text": "15 شارع عباس العقاد، الدور 4، شقة 12، مدينة نصر، القاهرة" },
  "scheduled_start": "2026-10-05T14:00:00Z", "scheduled_end": "2026-10-05T14:45:00Z",
  "provider": { "id": "p_1", "name": "منى حسن", "avatar_url": "...", "is_verified": true,
    "rating_avg": 4.8, "phone": "+2010..." },        // phone only after accepted [TBD]
  "price": { "subtotal": 25000, "discount": 5000, "total": 20000, "currency": "EGP" },
  "payment_method": "cash", "payment_status": "unpaid",
  "timeline": [
    { "status": "pending",    "at": "2026-10-04T18:00:00Z" },
    { "status": "accepted",   "at": "2026-10-04T18:05:00Z" },
    { "status": "on_the_way", "at": "2026-10-05T13:35:00Z" }
  ],
  "can_cancel": true, "can_reschedule": false, "can_review": false, "can_chat": true,
  "visit_report_id": null,
  "video": null        // for video bookings: { "join_available_at": "...", "room_id": "..." }
}}
```
> `timeline` is the only "tracking" — status changes set manually by the provider. **No location fields.**

#### `POST /bookings/{id}/cancel`
```json
{ "reason_code": "changed_mind", "reason_text": "optional" }
// 200 → { "status": "cancelled", "cancellation_fee": 0, "refund_amount": 0 }
```
Reason codes: `changed_mind | found_alternative | wrong_time | price | patient_condition | other`.

#### `POST /bookings/{id}/reschedule`
```json
{ "scheduled_start": "2026-10-06T10:00:00Z" }
```

#### `POST /bookings/{id}/review`
```json
{ "rating": 5, "comment": "ممرضة محترمة جداً", "tags": ["punctual", "professional"] }
```

#### `POST /bookings/{id}/dispute`
```json
{ "reason_code": "no_show", "description": "...", "attachments": ["tmp/..."] }
```
Reason codes: `no_show | late | unprofessional | wrong_price | service_quality | other`.

---

### 7.9 Patient — Packages & Promos

| Method | Path | Description |
|---|---|---|
| `GET` | `/packages?service_id=&area_id=` | Available packages |
| `GET` | `/packages/{id}` | Package details |
| `POST` | `/packages/{id}/subscribe` | Buy package (Idempotency-Key) |
| `GET` | `/me/package-subscriptions` | My packages + remaining visits |
| `POST` | `/promo-codes/validate` | Check promo |

#### `POST /packages/{id}/subscribe`
```json
{ "patient_profile_id": "pp_2", "payment_method": "card" }
// 201 → { "subscription_id": "ps_1", "payment_action": { "checkout_url": "..." } }
```

#### `POST /promo-codes/validate`
```json
{ "code": "WELCOME20", "service_id": "s_3", "subtotal": 25000 }
// 200 → { "valid": true, "discount": 5000, "description": "خصم 20% على أول حجز" }
```

---

### 7.10 Provider (roles: provider, provider_staff)

`provider_staff` cannot edit prices/services/areas (managed by the organization) and has no payouts screen.

**Onboarding & profile**
| Method | Path | Description |
|---|---|---|
| `GET` | `/provider/profile` | My provider profile + onboarding checklist |
| `PATCH` | `/provider/profile` | type, specialty, bio, experience, license_number, syndicate_number, languages |
| `GET` | `/provider/documents` | My documents + review status |
| `POST` | `/provider/documents` | Attach uploaded document |
| `DELETE` | `/provider/documents/{id}` | Remove (only if not approved) |
| `POST` | `/provider/submit-verification` | Submit for admin review (`draft/rejected → pending`) |
| `GET` | `/provider/verification-status` | Status + rejection reason |

**Coverage, services & schedule**
| Method | Path | Description |
|---|---|---|
| `GET` | `/provider/service-areas` | Selected areas |
| `PUT` | `/provider/service-areas` | Replace selected areas |
| `GET` | `/provider/services` | My services & prices |
| `PUT` | `/provider/services` | Replace services & prices |
| `GET` | `/provider/availability` | Weekly schedule |
| `PUT` | `/provider/availability` | Replace weekly schedule |
| `GET` | `/provider/time-off` | List time off |
| `POST` | `/provider/time-off` | Add |
| `DELETE` | `/provider/time-off/{id}` | Remove |
| `PATCH` | `/provider/accepting` | Toggle accepting bookings |

**Bookings**
| Method | Path | Description |
|---|---|---|
| `GET` | `/provider/home` | Dashboard: today's visits, pending requests, today's earnings |
| `GET` | `/provider/bookings?status=&date=` | My bookings |
| `GET` | `/provider/bookings/{id}` | Details + patient medical summary (access-controlled) |
| `GET` | `/provider/offers` | Open broadcast offers for me (first to accept wins) |
| `POST` | `/provider/offers/{id}/accept` | Accept offer → `409 OFFER_TAKEN` if someone accepted first |
| `POST` | `/provider/offers/{id}/decline` | Decline offer |
| `POST` | `/provider/bookings/{id}/accept` | `pending → accepted` |
| `POST` | `/provider/bookings/{id}/decline` | `pending → declined` |
| `POST` | `/provider/bookings/{id}/on-the-way` | `accepted → on_the_way` (manual, no location) |
| `POST` | `/provider/bookings/{id}/start` | `on_the_way/accepted → in_progress` |
| `POST` | `/provider/bookings/{id}/complete` | `in_progress → completed` |
| `POST` | `/provider/bookings/{id}/no-show` | Patient not available |
| `POST` | `/provider/bookings/{id}/cancel` | Provider cancels (with reason; affects score) |
| `POST` | `/provider/bookings/{id}/report` | Submit visit report |
| `PATCH` | `/provider/bookings/{id}/report` | Edit report (within 24h) |
| `POST` | `/provider/bookings/{id}/cash-collected` | Confirm cash received |

**Earnings** (independent providers only)
| Method | Path | Description |
|---|---|---|
| `GET` | `/provider/earnings?from=&to=` | Totals: earned, commission, balance, commission due |
| `GET` | `/provider/ledger` | Paginated ledger entries |
| `GET` | `/provider/payouts` | Payout history |
| `PUT` | `/provider/payout-method` | Bank account / wallet number for payouts |
| `GET` | `/provider/reviews` | My reviews |

#### `GET /provider/profile`
```json
{ "data": {
  "id": "p_1", "type": "nurse", "verification_status": "draft",
  "is_accepting_bookings": false, "organization": null,
  "onboarding": {
    "profile_completed": true, "documents_uploaded": false,
    "areas_selected": false, "services_set": false, "availability_set": false,
    "can_submit": false
  }
}}
```

#### `POST /provider/documents`
```json
{ "type": "syndicate_card", "file_key": "tmp/ab12..." }
```

#### `PUT /provider/service-areas`
Areas chosen from a searchable multi-select list (`GET /areas?search=`). **No map / radius.**
```json
{ "areas": [
  { "area_id": "a_12", "travel_fee": 0 },
  { "area_id": "a_13", "travel_fee": 3000 },
  { "area_id": "a_20", "travel_fee": 5000 }
]}
```

#### `PUT /provider/services`
```json
{ "services": [
  { "service_id": "s_3", "price": 25000, "is_active": true },
  { "service_id": "s_5", "price": 8000,  "is_active": true }
]}
```

#### `PUT /provider/availability`
```json
{ "slots": [
  { "day_of_week": 0, "start_time": "09:00", "end_time": "15:00" },   // 0 = Sunday
  { "day_of_week": 1, "start_time": "09:00", "end_time": "15:00" }
]}
```

#### `POST /provider/time-off`
```json
{ "starts_at": "2026-10-10T00:00:00Z", "ends_at": "2026-10-12T23:59:00Z", "reason": "إجازة" }
```

#### `PATCH /provider/accepting`
```json
{ "is_accepting_bookings": true }
// 403 PROVIDER_NOT_VERIFIED if not approved
```

#### `GET /provider/bookings/{id}`
```json
{ "data": {
  "id": "b_1", "status": "accepted", "service": { "name": "غيار على جرح" },
  "scheduled_start": "...", "scheduled_end": "...",
  "patient": { "full_name": "محمود علي", "age": 76, "gender": "male", "phone": "+2010..." },
  "address": { "full_text": "15 شارع عباس العقاد، الدور 4، شقة 12، مدينة نصر", "landmark": "بجوار صيدلية العزبي" },
  "medical_summary": { "conditions": ["سكر"], "medications": ["Glucophage 1000mg"], "allergies": ["بنسلين"] },
  "patient_notes": "المريض لا يستطيع الحركة",
  "price": { "total": 20000, "provider_payout": 16000 },
  "payment_method": "cash",
  "allowed_actions": ["on_the_way", "cancel"]
}}
```
> Patient phone, full address, and medical summary are hidden while `pending` (only area + service + time are shown).

#### `POST /provider/bookings/{id}/decline`
```json
{ "reason_code": "not_available" }   // not_available | too_far | other
```

#### `POST /provider/bookings/{id}/report`
```json
{
  "summary": "تم تغيير الغيار...",
  "vitals": { "bp": "130/85", "pulse": 82, "temp": 37.1, "sugar": 145, "spo2": 97 },
  "procedures_done": ["غيار جرح", "قياس سكر"],
  "recommendations": "متابعة بعد يومين",
  "attachments": ["tmp/..."]
}
```

#### `GET /provider/earnings`
```json
{ "data": {
  "period": { "from": "2026-10-01", "to": "2026-10-31" },
  "completed_visits": 42, "gross": 1050000, "commission": 189000, "net": 861000,
  "wallet_balance": 320000,          // platform owes provider (card/wallet bookings)
  "commission_due": 95000,           // provider owes platform (cash bookings)
  "currency": "EGP"
}}
```

---

### 7.11 Owner — Organization (role: owner)

**Organization setup**
| Method | Path | Description |
|---|---|---|
| `POST` | `/org` | Create organization (after register) |
| `GET` | `/org` | My organization |
| `PATCH` | `/org` | Update info |
| `POST` | `/org/logo` | Upload logo |
| `GET` | `/org/documents` | Documents |
| `POST` | `/org/documents` | Attach commercial register / tax card |
| `POST` | `/org/submit-verification` | Submit for review |
| `GET` | `/org/service-areas` | Areas + travel fee + team size per area |
| `PUT` | `/org/service-areas` | `{ "areas": [ { "area_id", "travel_fee" } ] }` |

**Dashboard & team**
| Method | Path | Description |
|---|---|---|
| `GET` | `/org/dashboard` | KPIs for today / week / month |
| `GET` | `/org/staff?status=&type=` | Team list |
| `POST` | `/org/staff/invite` | Invite nurse/doctor by phone |
| `GET` | `/org/staff/invites` | Pending invites |
| `DELETE` | `/org/staff/invites/{id}` | Revoke invite |
| `GET` | `/org/staff/{id}` | Staff details + performance |
| `PATCH` | `/org/staff/{id}` | Suspend / activate, edit services |
| `DELETE` | `/org/staff/{id}` | Remove from organization |
| `PUT` | `/org/staff/{id}/availability` | Set staff schedule |
| `PUT` | `/org/staff/{id}/service-areas` | Set staff areas |

**Bookings**
| Method | Path | Description |
|---|---|---|
| `GET` | `/org/bookings?status=&date=&staff_id=` | All org bookings |
| `GET` | `/org/bookings/{id}` | Details |
| `POST` | `/org/bookings/{id}/assign` | Assign to staff member |
| `POST` | `/org/bookings/{id}/reassign` | Change assigned staff |
| `GET` | `/org/bookings/{id}/eligible-staff` | Staff sorted by area coverage, availability and preferred gender; clashing staff flagged `available: false` |
| `POST` | `/org/bookings/{id}/broadcast` | "Send to all suitable" — offers to all eligible staff, first to accept wins |
| `POST` | `/org/bookings/{id}/decline` | Decline on behalf of org |
| `POST` | `/org/bookings/{id}/cancel` | Cancel |

**Services, packages, finance**
| Method | Path | Description |
|---|---|---|
| `GET` | `/org/services` | Org services & prices |
| `PUT` | `/org/services` | Replace services & prices |
| `GET` | `/org/packages` | Org packages |
| `POST` | `/org/packages` | Create |
| `PATCH` | `/org/packages/{id}` | Update |
| `DELETE` | `/org/packages/{id}` | Deactivate |
| `GET` | `/org/reports?from=&to=&group_by=day\|staff\|service` | Performance report |
| `GET` | `/org/invoices` | Platform invoices (commission + subscription) |
| `GET` | `/org/invoices/{id}/pdf` | Download invoice (signed URL) |
| `GET` | `/org/earnings` / `GET /org/ledger` / `GET /org/payouts` | Finance (same shapes as provider) |
| `PUT` | `/org/payout-method` | Bank details |
| `GET` | `/org/subscription` | Current plan + usage |
| `GET` | `/subscription-plans` | Available plans |
| `POST` | `/org/subscription` | Subscribe / change plan |

#### `POST /org`
```json
{ "name": "مركز الشفاء للتمريض", "type": "nursing_center",
  "commercial_register_no": "123456", "tax_id": "987-654-321",
  "description": "...", "phone": "+2022...", "address_text": "..." }
```

#### `GET /org/dashboard?period=today|week|month`
```json
{ "data": {
  "bookings": { "total": 38, "pending": 4, "unassigned": 2, "in_progress": 5, "completed": 27, "cancelled": 2 },
  "staff": { "total": 15, "active_now": 9 },
  "revenue": { "gross": 950000, "commission": 171000, "net": 779000 },
  "rating_avg": 4.7,
  "alerts": [ { "type": "unassigned_booking", "booking_id": "b_9", "message": "حجز بدون ممرض منذ 20 دقيقة" } ]
}}
```

#### `POST /org/staff/invite`
Sends SMS invite; the invitee registers/logs in and becomes `provider_staff` linked to the org (still needs document verification).
```json
{ "phone": "+201223334445", "full_name": "سارة أحمد", "type": "nurse" }
```

#### `POST /org/bookings/{id}/assign`
```json
{ "provider_profile_id": "p_22" }
// 409 SLOT_UNAVAILABLE if staff member is busy / not covering the area
```

#### `GET /org/reports`
```json
{ "data": {
  "summary": { "visits": 312, "revenue": 7800000, "avg_rating": 4.7, "cancellation_rate": 0.04, "on_time_rate": 0.92 },
  "rows": [ { "key": "سارة أحمد", "visits": 44, "revenue": 1100000, "rating": 4.9, "on_time_rate": 0.95 } ]
}}
```

---

### 7.12 Chat (patient ↔ provider, per booking)

Available from `accepted` until 24h after `completed`.

| Method | Path | Description |
|---|---|---|
| `GET` | `/conversations` | My conversations (last message, unread count) |
| `GET` | `/bookings/{id}/messages?before=` | Messages (cursor pagination) |
| `POST` | `/bookings/{id}/messages` | Send `{ "body": "...", "attachment_key": null }` |
| `POST` | `/bookings/{id}/messages/read` | Mark as read |

**WebSocket** (`wss://api.reaya.app/ws?token=<access_token>`)
| Channel | Events |
|---|---|
| `booking.{id}` | `booking.status_changed`, `message.new`, `message.read` |
| `user.{id}` | `notification.new`, `booking.new_request` (providers/owners) |

```json
// booking.status_changed
{ "event": "booking.status_changed", "booking_id": "b_1",
  "from": "accepted", "to": "on_the_way", "at": "2026-10-05T13:35:00Z" }
```

---

### 7.13 Notifications

| Method | Path | Description |
|---|---|---|
| `GET` | `/notifications` | Paginated list |
| `POST` | `/notifications/read` | `{ "ids": [...] }` or `{ "all": true }` |
| `GET` | `/me/notification-settings` | Preferences |
| `PUT` | `/me/notification-settings` | `{ "reminders": true, "promotions": false, "chat": true }` |

Push payload `data` always contains `type` + ids for deep linking:
```json
{ "type": "booking_status", "booking_id": "b_1", "status": "accepted" }
```
Types: `booking_request | booking_offer | assignment_deadline_warning | booking_status | booking_reminder | chat_message | visit_report | review_request | verification_result | payout | package_expiry | promo`.

---

### 7.14 Payments

| Method | Path | Description |
|---|---|---|
| `POST` | `/payments/initiate` | Start card/wallet payment (Idempotency-Key) |
| `GET` | `/payments/{id}` | Payment status (poll after returning from gateway) |
| `POST` | `/webhooks/payments/{gateway}` | Gateway callback (public, signature-verified, idempotent) |
| `GET` | `/me/payments` | Payment history + receipts |

#### `POST /payments/initiate`
```json
// body
{ "purpose": "booking", "reference_id": "b_1", "method": "card" }   // purpose: booking | package
// 200
{ "data": { "payment_id": "pay_1", "checkout_url": "https://gateway...", "expires_at": "..." } }
```
Flow: app opens `checkout_url` in WebView → gateway redirects to `reaya://payment-result?payment_id=pay_1` → app calls `GET /payments/{id}`. The webhook is the source of truth for `paid` status.

---

### 7.15 Admin (role: admin, web panel)

All under `/admin`. Every write action is written to `audit_logs`. Admin sub-roles **[TBD]**: `super_admin | verifier | support | finance`.

**Dashboard**
| Method | Path | Description |
|---|---|---|
| `GET` | `/admin/dashboard` | Platform KPIs (bookings, GMV, revenue, active providers, pending verifications, open disputes), 14-day bookings chart, today by status, top areas, recent activity |
| `GET` | `/admin/attention` | "Needs attention" list: org requests past deadline, expired open offers, failed payments, documents expiring soon |
| `GET` | `/admin/analytics?metric=&from=&to=&group_by=` | Time-series charts |

**Verification**
| Method | Path | Description |
|---|---|---|
| `GET` | `/admin/verifications?type=provider\|organization&status=pending` | Queue |
| `GET` | `/admin/verifications/{id}` | Full submission + document signed URLs |
| `POST` | `/admin/verifications/{id}/approve` | Approve |
| `POST` | `/admin/verifications/{id}/request-changes` | `{ "documents": ["license"], "message": "..." }` → `changes_requested`; applicant re-uploads and re-submits |
| `POST` | `/admin/verifications/{id}/reject` | `{ "reason": "...", "documents": ["license"] }` |
| `POST` | `/admin/documents/{id}/review` | Approve/reject a single document |

**Users, providers, organizations**
| Method | Path | Description |
|---|---|---|
| `GET` | `/admin/users?role=&status=&search=` | List users |
| `GET` | `/admin/users/{id}` | User details |
| `POST` | `/admin/users/{id}/suspend` | `{ "reason": "...", "duration_days": 7, "notify": true }` (`duration_days: null` = indefinite). Future bookings are cancelled/reassigned automatically |
| `POST` | `/admin/users/{id}/warn` | `{ "reason": "...", "related_type": "dispute", "related_id": "d_1", "notify": true }` |
| `GET` | `/admin/users/{id}/history` | Suspensions, warnings, disputes, audit trail |
| `POST` | `/admin/users/{id}/activate` | Reactivate |
| `GET` | `/admin/providers?verification_status=&area_id=&type=` | List providers |
| `GET` | `/admin/providers/{id}` | Details + stats |
| `PATCH` | `/admin/providers/{id}` | Edit / suspend provider |
| `GET` | `/admin/organizations` | List |
| `GET` | `/admin/organizations/{id}` | Details |
| `PATCH` | `/admin/organizations/{id}` | Edit / custom commission rate |

**Bookings & disputes**
| Method | Path | Description |
|---|---|---|
| `GET` | `/admin/bookings?status=&date_from=&date_to=&area_id=&search=` | List |
| `GET` | `/admin/bookings/{id}` | Full details + status history + payments |
| `POST` | `/admin/bookings/{id}/status` | Force status `{ "status": "...", "note": "..." }` |
| `POST` | `/admin/bookings/{id}/reassign` | Reassign provider |
| `POST` | `/admin/bookings/{id}/refund` | `{ "amount": 20000, "reason": "..." }` |
| `GET` | `/admin/disputes?status=open` | Disputes |
| `GET` | `/admin/disputes/{id}` | Details |
| `POST` | `/admin/disputes/{id}/resolve` | `{ "resolution": "refund\|partial_refund\|no_action", "refund_amount": 10000, "provider_action": "none\|warn\|suspend", "suspend_days": 7, "message_to_patient": "...", "message_to_provider": "..." }` |

**Reviews**
| Method | Path | Description |
|---|---|---|
| `GET` | `/admin/reviews?flagged=true` | List |
| `PATCH` | `/admin/reviews/{id}` | `{ "is_visible": false }` or `{ "mask_contact": true }` (hides phone numbers / contact info inside the comment) |

**Catalog & locations**
| Method | Path | Description |
|---|---|---|
| `GET/POST` | `/admin/service-categories` | List / create |
| `PATCH/DELETE` | `/admin/service-categories/{id}` | Update / delete |
| `GET/POST` | `/admin/services` | List / create |
| `PATCH/DELETE` | `/admin/services/{id}` | Update (incl. min/max price) / deactivate |
| `GET/POST` | `/admin/governorates` | List / create |
| `PATCH` | `/admin/governorates/{id}` | Update / activate |
| `GET/POST` | `/admin/areas` | List / create |
| `PATCH` | `/admin/areas/{id}` | Update / activate |

**Marketing**
| Method | Path | Description |
|---|---|---|
| `GET/POST` | `/admin/promo-codes` | List / create |
| `PATCH/DELETE` | `/admin/promo-codes/{id}` | Update / deactivate |
| `GET/POST` | `/admin/banners` | Home banners |
| `PATCH/DELETE` | `/admin/banners/{id}` | Update / delete |
| `POST` | `/admin/notifications/broadcast` | Push to a segment `{ "role": "patient", "area_ids": [], "title": "...", "body": "..." }` |
| `GET/POST` | `/admin/packages` | Platform packages |
| `GET/POST` | `/admin/subscription-plans` | Org plans |

**Finance**
| Method | Path | Description |
|---|---|---|
| `GET` | `/admin/payments?status=&method=` | All payments |
| `GET` | `/admin/payouts?status=pending` | Payout queue |
| `POST` | `/admin/payouts/generate` | Generate payout batch for a period |
| `POST` | `/admin/payouts/{id}/mark-paid` | `{ "reference": "bank ref" }` |
| `POST` | `/admin/payouts/bulk-approve` | `{ "payout_ids": [...] }` |

> Payout schedule: weekly batch every **Thursday** (setting `payout_day`), generated automatically by a job; admin reviews and bulk-approves.
| `GET` | `/admin/commission-dues` | Providers owing commission (cash bookings) |
| `POST` | `/admin/ledger/adjustment` | Manual credit/debit `{ "owner_type", "owner_id", "amount", "reason" }` |
| `GET` | `/admin/reports/export?type=bookings\|payments\|payouts&from=&to=` | CSV export |

**System**
| Method | Path | Description |
|---|---|---|
| `GET` | `/admin/settings` | All settings |
| `PUT` | `/admin/settings` | Update (commission rate, `org_assign_deadline_minutes` (25), `fallback_window_minutes` (20), `direct_request_response_minutes` (3), `on_time_grace_minutes` (15), `cancellation_free_window_hours` (3), `referral_reward` (5000), `payout_day` (thursday), cancellation window, feature flags, app versions) |
| `GET` | `/admin/audit-logs?actor_id=&entity_type=&entity_id=` | Audit trail |
| `GET/POST` | `/admin/admins` | Manage admin accounts |
| `PATCH` | `/admin/admins/{id}` | Change sub-role / disable |

---

### 7.16 Screen → Endpoint Map (for the mobile team)

| Screen | Endpoints |
|---|---|
| Splash | `GET /app-config`, `POST /auth/refresh` |
| Login / OTP | `POST /auth/otp/request`, `POST /auth/otp/verify` |
| Register + role select | `POST /auth/register` |
| Patient home | `GET /home` |
| Service details | `GET /services/{id}` |
| Choose patient + address | `GET /patient-profiles`, `GET /addresses`, `POST /addresses` |
| Provider list + filters | `GET /providers` |
| Provider profile | `GET /providers/{id}`, `GET /providers/{id}/reviews` |
| Pick date/time | `GET /providers/{id}/slots` |
| Booking summary | `POST /bookings/quote`, `POST /promo-codes/validate` |
| Confirm + pay | `POST /bookings`, `POST /payments/initiate`, `GET /payments/{id}` |
| Booking status (timeline) | `GET /bookings/{id}` + WS `booking.{id}` |
| Chat | `GET/POST /bookings/{id}/messages` + WS |
| Rate visit | `POST /bookings/{id}/review` |
| My bookings | `GET /bookings` |
| Medical profile | `/patient-profiles/{id}/...` |
| Visit reports | `GET /patient-profiles/{id}/visit-reports` |
| Packages | `GET /packages`, `POST /packages/{id}/subscribe`, `GET /me/package-subscriptions` |
| Notifications | `GET /notifications`, `POST /notifications/read` |
| Settings / account | `GET/PATCH /me`, `/me/notification-settings`, `DELETE /me` |
| Provider onboarding | `PATCH /provider/profile`, `POST /uploads`, `POST /provider/documents`, `PUT /provider/service-areas`, `PUT /provider/services`, `PUT /provider/availability`, `POST /provider/submit-verification` |
| Provider home | `GET /provider/home`, `PATCH /provider/accepting` |
| Incoming request | WS `user.{id}` → `GET /provider/bookings/{id}` → `accept` / `decline` (or `GET /provider/offers` → `offers/{id}/accept`) |
| Owner assign request | `GET /org/bookings/{id}/eligible-staff`, `POST /org/bookings/{id}/assign` or `/broadcast` |
| Owner area fees tab | `GET/PUT /org/service-areas` |
| Active visit | `on-the-way`, `start`, `complete`, `cash-collected` |
| Visit report form | `POST /provider/bookings/{id}/report` |
| Earnings | `GET /provider/earnings`, `/provider/ledger`, `/provider/payouts` |
| Owner dashboard | `GET /org/dashboard` |
| Owner team | `/org/staff/...` |
| Owner bookings + assign | `GET /org/bookings`, `POST /org/bookings/{id}/assign` |
| Owner services / packages | `/org/services`, `/org/packages` |
| Owner reports | `GET /org/reports`, `GET /org/invoices` |


---

## 8. Notifications (push + in-app)

| Event | Recipient |
|---|---|
| New booking request | Provider / Owner |
| Broadcast offer available / offer taken by someone else | Provider / Staff |
| Assignment deadline warning (e.g. 10 min left) | Owner |
| Request moved to other providers (fallback) | Owner + Patient |
| Booking accepted / declined / expired | Patient |
| Provider on the way / visit started / completed | Patient |
| Booking cancelled | Other party |
| Reminder 24h and 1h before visit | Both |
| New chat message | Other party |
| Visit report available | Patient |
| Review request after completion | Patient |
| Verification approved / rejected | Provider / Owner |
| Payout processed | Provider / Owner |
| Package about to expire / low visits | Patient |

All notification texts are in Arabic at launch, stored in translation files (English added later).

---

## 9. Security & Privacy

- Comply with **Egypt's Personal Data Protection Law (Law 151 of 2020)** — health data is sensitive data. Legal review **[TBD]**.
- HTTPS everywhere; encrypt sensitive columns at rest (medical data, national ID data, license numbers).
- Private file storage; access only through short-lived signed URLs, with permission checks.
- **Access control:** a provider can see a patient's medical profile **only** for their active/recent bookings with that patient **[TBD: e.g. up to 7 days after completion]**. Owners see only their organization's bookings.
- Hide the patient's full address and phone until the booking is `accepted`.
- OTP: rate limiting per phone and per IP, max attempts, short expiry.
- Audit log for all access to medical data and all admin actions.
- Account deletion flow with data retention policy **[TBD]**.
- No location data collection (see §1).

---

## 10. Non-Functional Requirements

- Localization: Arabic only at launch. Store names as `name_ar` (required) / `name_en` (nullable, for future). All strings in translation files.
- Timezone: store UTC, display in `Africa/Cairo`.
- Currency: EGP, store money as integer piastres (or `NUMERIC(12,2)`), never floats.
- Idempotency keys on booking creation and payment endpoints.
- Background jobs: booking expiry, reminders, package expiry, rating recalculation, payout batches.
- Monitoring & error tracking (e.g. Sentry), structured logs.
- Environments: dev, staging, production. Seed data for staging.
- Target p95 API latency < 300ms for read endpoints.

---

## 11. Delivery Phases

**Phase 1 — MVP (nursing only)**
Auth (OTP), patient profiles + addresses, areas, services catalog, provider onboarding + document upload, admin verification, provider search by area, booking flow + status state machine, cash payment, push notifications, visit reports, reviews, basic admin panel.

**Phase 2**
Doctors + home visits, video consultations, card/wallet payments, in-app chat, packages, promo codes & referrals, provider earnings & payouts.

**Phase 3**
Organizations (owner dashboard, staff, assignment, subscriptions, reports), web dashboard for owners, advanced admin analytics, insurance partnerships.

---

## 12. Open Questions [TBD]

1. SMS/OTP provider and payment gateway choice.
2. In-app calling vs revealing phone numbers after acceptance vs masked numbers.
3. Booking request timeout and cancellation / refund policy.
4. Provider access window to patient medical data after a visit.
5. Can one user hold multiple roles (e.g. a nurse who is also a patient)?
6. Min/max price bounds per service set by admin?
7. Package visit decremented on acceptance or on completion?
8. Real-time layer: self-hosted WebSockets or Firebase?
9. Data retention period after account deletion.
10. Does the travel fee carry platform commission, or go 100% to the provider/organization?
11. Is preferred gender a strict filter or a soft preference?
12. Must the patient agree to fallback when booking a specific organization (default on)?
13. Is 3 minutes enough for a provider to answer a direct request, especially for bookings scheduled days ahead?
14. Should an expired license auto-pause the provider?

---

## 13. Changelog

**v2.2**
- Verification: new `changes_requested` state + request-changes endpoint; per-document review status and expiry date.
- Admin: timed suspensions, user warnings, user history, "needs attention" list, review contact masking, dispute resolution with provider actions and messages to both parties, weekly Thursday payout batches with bulk approve.
- Areas: admin `max_travel_fee` cap.
- Settings defaults aligned with the admin design: fallback window 20 min, direct request response 3 min, cancellation window 3 h, referral 50 EGP each side.

**v2.1**
- Arabic-only launch (English later; backend kept i18n-ready).
- Area travel fees per provider / organization (`travel_fee` on service areas, new line in quote).
- Preferred provider gender on bookings.
- Organization assignment deadline (25 min) + "send to all suitable" + automatic fallback to other providers, via new `booking_offers` table and `/provider/offers` endpoints.
- On-time metric (started within 15 min of booked time, based on manual status).

---

*Design reference: the mobile UI is designed in Claude Design (Arabic RTL only at launch). Coordinate screen flows with the design team to confirm payloads for each screen.*
