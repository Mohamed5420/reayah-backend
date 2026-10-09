# Clinic visits — API changes for the mobile apps

Doctor bookings can now be a **clinic visit** (the patient goes to the clinic) as well as a home visit.
Nurses stay home-visit only; video stays deferred. Everything below is live on the API but switched off
until launch by the setting `features.clinic_visits` (in `GET /app-config` → `features.clinic_visits`).
While it is off, clinic search, slots and quotes answer `422` with `fields.visit_type`, and nothing in the
existing home-visit flow changes.

Full request / response shapes: the API reference (Swagger) and `docs/openapi.json`.

## What could break an app

Most changes only add fields. Check these four:

1. **New enum value** `clinic_visit` for booking `type` (and `visit_type` everywhere). Apps that parse
   enums strictly must accept it.
2. **New role** `reception` (user `role`), and the sign-up invite list (`POST /auth/otp/verify` →
   `staff_invites[]`) now has `kind` (`staff` | `reception`), with `type` `null` for reception invites.
3. **Doctor's `allowed_actions`** for clinic visits contain `start_with_code` instead of `start`, and never
   `on_the_way`.
4. **`POST /bookings/quote`**: `address_id` is now optional (required for home visits only); clinic visits
   send `clinic_id` instead.

## Patient app

| Screen | API |
| --- | --- |
| Search: clinic or home | `GET /providers?service_id&area_id&visit_type=clinic_visit` — `area_id` is **the clinic's area**. One card per doctor and clinic (`kind: provider`), or per organization branch (`kind: organization`). Cards add `visit_type` and `clinic: { id, name, area }`; `travel_fee` is 0. No phone or street on cards. Home search cards have `visit_type: home_visit`, `clinic: null`. |
| Doctor / organization profile | `GET /providers/{id}` adds `visit_types` and `clinics[]` (text address, landmark, hours, `appointment_minutes`, clinic prices; organizations also `doctors[]`). Never the clinic phone. |
| Slots | `GET /providers/{id}/slots?service_id&date&visit_type=clinic_visit&clinic_id=…` (organizations: optional `doctor_id`). Fixed appointment times. |
| Quote / book | `POST /bookings/quote` with `type: clinic_visit`, `clinic_id`, `provider_id` (a doctor) and / or `organization_id` (a branch; with `provider_id` = a specific doctor there). No `address_id`. Then `POST /bookings` as today. |
| After booking | Usually `accepted` at once (instant confirmation). Booking detail adds `clinic: { id, name, phone }` (phone once confirmed), `visit_code` (4 digits, show it at the clinic; shown while accepted) and `address.landmark`; `address` holds the clinic's address. |
| Status | No "on the way". Cancellation: free inside the free window; late cancellation / no-show fees are a percentage of the consultation (0 at launch). |
| Limits | Errors `409` with a clear Arabic message: an overlapping clinic appointment, a second upcoming appointment with the same doctor for the same patient, more than 3 upcoming clinic appointments. |
| Notifications | `clinic_booking_confirmed`, `clinic_booking_no_show`, `clinic_booking_expired` (data `action: choose_again` → open search again). |
| Packages / promos | Packages have `visit_type`; a clinic package works for clinic visits only. `POST /promo-codes/validate` takes optional `visit_type`. |

## Doctor app

- **Clinics:** `/provider/clinics` — list, create (text address, phone), `PATCH`, `DELETE`, `PUT …/licence`, `POST …/submit`, `PUT …/schedule` (`slot_minutes`, `instant_confirm`, `hours`). Status `draft → pending → approved / changes_requested / rejected`. Hours can't overlap home-visit hours or another clinic (`422`, field `hours.N`).
- **Prices per visit type:** `PUT /provider/services` entries take `visit_type` (default `home_visit`); `GET` returns `visit_type` and the bounds for it.
- **Onboarding checklist** adds `clinics_set`.
- **At the clinic:** `POST /provider/bookings/{id}/start` with `{ "visit_code": "1234" }` or `{ "without_code_reason": "…" }`. Detail adds `clinic` and `check_in`. No-show from start + 15 minutes.

## Organization owner (mobile + web)

- **Branches:** `/org/branches` (same flow as doctors' clinics) and `PUT /org/branches/{id}/doctors/{staffId}` to place a doctor there with hours.
- **Reception:** `POST /org/branches/{id}/reception` (phone + name; the number must be new to the app), `GET` (members + open invites), `DELETE /org/branches/{id}/reception/{userId}`.
- **Queue:** "any doctor" branch bookings arrive like other organization bookings. `eligible-staff` gains the reason `branch`. If the deadline passes, the system assigns a free doctor at the branch, or the booking expires.
- **Reports:** `GET /org/reports?group_by=branch`.

## Reception app (new role)

- Sign up with role `reception` and the invite's `staff_invite_id`.
- `GET /reception/appointments`: today's appointments at the branch (patient name, time, service, doctor, status, `checked_in`).
- `POST /reception/appointments/{id}/check-in` with `visit_code` or `without_code_reason`, and `POST /reception/appointments/{id}/no-show`.
- Reception can't use any other part of the app.

## Screens

The full screen list (new and changed) is in section 10 of the clinic-visits plan.
