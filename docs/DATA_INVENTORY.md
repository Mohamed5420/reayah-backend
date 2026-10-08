# Reaya+ Personal Data Inventory

**Prepared for:** legal review under the Personal Data Protection Law (Law 151 of 2020) and its executive regulations
**Last updated:** 8 October 2026 (through build milestone M3.4)
**Source of truth:** this file (`docs/DATA_INVENTORY.md`), updated with every milestone. The Word copy (`docs/DATA_INVENTORY.docx`) is generated from it.

## About this document

Reaya+ (رعاية+) is an Egyptian app that books home nursing and doctor visits. This document lists every kind of personal and health data the app handles, so counsel can assess it under Law 151 of 2020. Health data is sensitive data under that law.

It covers what is built so far:

- **Patients** and the family members they book for.
- **Independent nurses and doctors** (doctor services are built but switched off at launch).
- **Card and mobile-wallet payments** through Paymob, provider earnings and weekly payouts.
- **In-app chat** between a patient and the assigned nurse or doctor.
- **Packages, promo codes, referrals** and in-app credit.
- **Organizations** (nursing centers, clinics, labs, elderly-care companies): set-up, verification, their teams of nurses and doctors (staff), bookings made with an organization (its owner assigns a staff member), and their finances: earnings, payouts, plans, monthly statements and their own packages.
- **The Reaya+ admin team.**

Video consultations are on hold and not covered.

The system is built but not yet live. No real patient data exists yet, and the hosting provider has not been chosen, so decisions made now can still shape it.

## Data we collect

We collect identity and contact data from everyone, health data about patients, professional credentials from nurses and doctors, business documents from organizations, and payment and earnings records. We collect no location data of any kind: matching is by the area the patient picks from a list, and providers report "on my way" by hand.

| Data | About whom | Examples | Why we need it | Sensitive? |
| --- | --- | --- | --- | --- |
| Account identity | Everyone | Mobile number, full name, gender, date of birth, email (optional), profile photo (optional), language | Sign-in by SMS code; showing the right provider gender; age for care | No |
| Family members' profiles | Patients' relatives, entered by the patient | Name, relation (father, mother, child…), gender, date of birth | Booking care for a relative | No |
| Medical profile | Patient and each family member | Blood type, conditions + notes, medications + dosage and frequency, allergies + severity | So the nurse or doctor knows the patient's condition before and during the visit | **Yes** |
| Medical documents | Patient and family | Prescriptions, lab results, reports (photos or PDF) | Same as above | **Yes** |
| Home addresses | Patients | Label, governorate, area, street, building, floor, apartment, landmark, notes (text only, no coordinates) | Where the visit happens | No |
| Bookings | Patients and providers | Service, date and time, price and discounts, status history, cancellation reasons, notes to the provider, and any travel-fee charge for a cancellation after the provider set off or a no-show | Running the visit; billing; dispute handling | Notes: **Yes** (may describe the condition) |
| Cancellation record | Patients | Per patient: late cancellations (within the free-cancellation window, before the provider set off) and travel-fee charges, including cash charges not collected | Spotting repeated late cancellations and no-shows | No |
| Visit reports | Patients, written by the provider | Summary, vital signs (blood pressure, pulse, temperature, sugar, oxygen), procedures done, recommendations, attachments | Part of the patient's medical record | **Yes** |
| Chat messages | Patient and the assigned nurse or doctor | Text messages and attached photos or PDFs about one booking | Arranging the visit (open from acceptance until 24 hours after it ends) | **Yes** (may describe the condition) |
| Reviews | Patients about providers | Rating 1–5, comment, tags | Quality; helping patients choose | No (shown publicly as first name + initial) |
| Disputes | Patients | Reason, description, attachments; admin decision, refund and who bears it | Resolving complaints | Description: **Yes** (may hold health details) |
| Provider credentials | Nurses and doctors | License and syndicate numbers, national ID photos (front, back), license and syndicate card photos, certificates, specialty (doctors), years of experience, bio | Verifying the provider before they can work | **Yes** (identity documents) |
| Provider coverage and prices | Nurses and doctors | Areas served, travel fee, services and prices, weekly hours, time off | Matching patients with available providers | No |
| Organization details | Organizations and their owner | Name, type, commercial register number, tax id, description, contact phone, business address (text), logo, commercial register and tax card scans, areas served with travel fees, services and prices | Verifying the business before it can receive bookings; showing it to patients | Business data; the scans may show the owner's personal details |
| Clinics (clinic visits, being built) | Doctors with their own clinic, and organizations' branches | Clinic name, text address (governorate, area, street, building, floor, landmark — no maps or coordinates), clinic phone (may be the doctor's own mobile), the clinic licence (scan, expiry date), the doctor's weekly hours there, appointment length, review status and admin notes | Verifying the clinic before patients can book it; telling patients where to go | Business data; the phone may be personal; the licence scan may show the doctor's personal details |
| Staff invites | People an organization invites to join its team | Mobile number and name as entered by the owner, nurse or doctor, invite status; an SMS invitation is sent to that number. The SMS contains only the organization's name and the app link, nothing about the person. | Letting the person join the organization's team | No (but entered by a third party: the owner) |
| Staff records | Nurses and doctors working for an organization | Which organization, suspended by the owner or not, the services, areas and weekly hours the owner set; performance (visits completed, rating, on-time rate) shown to the owner | Running the organization's team | No |
| Card and wallet payments | Patients who pay by card or mobile wallet; providers who pay the commission they owe through the app | Amount, status, Paymob order and transaction ids, card brand and last 4 digits, refunds. The full card number never reaches Reaya+; Paymob collects it on its own page. | Taking payment, receipts, refunds, provider earnings, commission settlement | No (financial) |
| Organization finances | Organizations | Earnings ledger (visit earnings, commission, plan fees and credits), payout details (encrypted account number), payouts with statements, monthly statements of platform charges (PDF), plan and its billing period, dashboard and report figures built from their bookings | Paying organizations, billing their plan, showing their performance | Financial (account number encrypted) |
| Earnings records | Nurses and doctors | Running balance and its entries: earnings from card visits, commission owed on cash visits, commission paid, discounts reimbursed, referral rewards, dispute deductions, adjustments; each payout with its statement | Paying providers and settling commission | No (financial) |
| Payout details | Nurses and doctors | Account holder name; bank name and IBAN / account number, or mobile-wallet provider and number | Paying out earnings | Financial (account number encrypted) |
| Package purchases | Patients (for themselves or a family profile) | Package bought (the platform's or an organization's), which patient profile, visits left, start and end dates, the card payment | Delivering prepaid visits | Health-related (the service implies a care need) |
| Promo code use | Patients | Which code, on which booking, the discount | Applying limits (per user, in total) | No |
| Referrals | Patients and providers | Who invited whom, a one-way keyed hash of the invited phone number, reward status | Paying referral rewards once per phone number | No (the phone is stored only as a hash) |
| In-app credit | Patients | Credit earned from referrals, used on and given back from bookings | Applying credit to bookings | No (financial) |
| Device and session data | Everyone | Push notification token, phone platform, app version, sign-in sessions, IP address on sign-in and admin actions | Notifications; security; abuse prevention | No |
| Notifications | Everyone | In-app messages about bookings, payments and the account; offers and service announcements from admin broadcasts (offers are pushed only to users with promotions on) | Keeping both sides informed | No |
| Broadcasts | Everyone (as recipients) | The message an admin sent, the segment (role, areas), who sent it, the reason (announcements), how many it reached; each recipient gets a normal in-app notification | Offers and service announcements | No (no list of recipients is stored) |
| Moderation records | Patients and providers | Suspensions, warnings, reasons | Platform safety | No |
| Audit log | Admins, and anyone whose medical data was opened | Who did what, when, from which IP; never the medical values themselves | Legal accountability | No |
| Consent records | Everyone who signs up | Which version of the terms, privacy notice and health-data consent the person accepted or withdrew, when, and from which IP | Proof of explicit consent to process health data | No (it records consent to sensitive data, not the data) |
| Test accounts | Our own testers and app-store reviewers | A flag on accounts created with our test numbers, which sign in with a fixed code instead of an SMS; each use is logged | Store review and testing without real SMS; test accounts never meet real users in production | No |

Home-screen banners and promo campaigns are marketing content uploaded by admins and hold no personal data.

## Where the data is stored

All personal data lives in one database and one private file store, both at a hosting provider not yet chosen. Our recommendation is a provider with a data centre in Egypt, pending counsel's answer on cross-border transfers (question 1). A few outside services receive only what they need to do their job.

| System | What it holds | Who runs it | Location |
| --- | --- | --- | --- |
| Main database (MongoDB) | Everything in the table above except files | Hosting provider (TBD) | TBD; recommended: Egypt |
| Private file storage | Medical documents, visit-report attachments, dispute attachments, chat attachments, provider ID and license photos, organization documents and logos, organizations' monthly statement PDFs, profile photos, banner images | Hosting provider (TBD) | Same as the database |
| Temporary store (Redis) | For up to 24 hours: copies of booking-creation responses (to stop double bookings on retries), queued push messages (kept 1 day, failed ones 7 days), rate-limit counters, cached public lists | Hosting provider (TBD) | Same as the database |
| Database backups | A full copy of the main database, made daily | Hosting provider (TBD) | Kept 14 days on the server; long-term copies off-server (location TBD) |
| SMS provider | Mobile number and the one-time sign-in code; for staff invites, the number, the organization's name and the app link (nothing else about the person) | Not yet chosen | TBD |
| Paymob (payment gateway) | Card or wallet details entered on its checkout page; from us: amount, a short description (service name and booking reference, package name, or "commission"), the payer's name and mobile number (email if given). No health data. | Paymob (licensed payment provider) | To confirm with Paymob |
| Firebase Cloud Messaging (Google) | Device push token and each notification's title and text (service name, visit time, provider name; never medical details, never chat text) | Google | Google's global infrastructure |
| Sentry (error tracking, optional) | Technical error reports. Its automatic collection of request bodies, headers and user details is switched off. | Sentry | Region chosen when the account is set up |
| Server logs | Request method, address (internal record ids, no names), status and timing; no IP addresses or request bodies | Hosting provider (TBD) | Same as the database; rotated at about 200 MB per service |

## How the data is protected

Health data, identity numbers and payout account numbers are encrypted inside the database, files are never public, and every look at medical data is recorded. Automated tests check these rules on every code change, so they cannot be dropped by accident.

- **Encryption of sensitive fields (AES-256-GCM):** blood type, conditions, medications, allergies, medical document titles, visit reports, booking notes, dispute descriptions, chat messages, provider license and syndicate numbers, payout account numbers (on the payout method and on each payout). A database copy or backup on its own shows only scrambled text; the key is kept separately from the data.
- **Encryption in transit:** the apps talk to the server over HTTPS only.
- **Private files:** medical documents, ID photos and organization documents sit in a private store. The app gets a link that expires after 10 minutes, and only after a permission check.
- **Payments:** card numbers are entered on Paymob's page and never reach Reaya+. Only Paymob's signed confirmation marks a payment as paid.
- **Sign-in:** by SMS code only (no passwords). Codes expire after 2 minutes, allow 5 attempts, and are rate-limited per number and per IP. Sessions expire, and a suspended or deleted account is locked out on its next request.
- **Least access:** a provider sees a patient's phone, address and notes only after accepting the booking, and the medical profile only during the visit and for 7 days after it. Providers see their payout account masked (last 4 digits).
- **Audit log:** every admin action, and every opening of medical data, booking notes, dispute descriptions or a booking's chat by an admin, is recorded with who, when and from which IP. The log never contains the medical values, and entries cannot be edited or deleted.
- **No location tracking:** the app collects no GPS or coordinates; tests reject any such field.
- **Public reviews** show the reviewer as first name + initial. Comments that look like they contain a phone number, email or link are held for an admin to check.
- **Referrals** store the invited phone number only as a keyed one-way hash.

## Who can access what

Each person sees only their own data, providers see a patient's details only for their own bookings and only for a limited time, and admins see what their admin role needs (super admins see everything), with every sensitive view logged.

| Who | What they can see | Limits |
| --- | --- | --- |
| Patient | Their own account, family profiles, medical records, addresses, bookings, visit reports, chats, payments, packages, credit and referral stats, disputes | Another patient's data returns "not found" |
| Provider (before accepting) | Service, time, area name and price of a request | No patient name, phone, address, notes or medical data |
| Provider (after accepting) | Patient name, age, gender, phone, full address, booking notes, the booking's chat | Only for bookings assigned to them; each view of the notes is logged |
| Provider (during the visit and 7 days after) | The patient's medical summary: conditions, medications, allergies | Each view is logged; access ends 7 days after the visit; nothing is shared while the patient has withdrawn health-data consent (the provider sees only that it was withheld) |
| Provider (own money) | Their earnings, ledger, payouts with statements, payout method (account number masked) | Only their own |
| Provider after an admin reassigns a booking | The new provider starts a fresh, empty conversation | Neither the previous nor the new provider can open the earlier conversation; the patient can still read it; it stays stored for admins (disputes) |
| Organization owner | Their organization's earnings, ledger, payouts, plan, monthly statements, dashboard and reports (built from their bookings: counts, revenue, ratings, on-time and cancellation rates — no patient names); their organization's details, documents, areas, services and prices; their staff's name, phone, gender, photo, verification status, services, areas, weekly hours and performance; their pending invites; their organization's bookings: service, time, area, preferred gender, price and status, plus — once a staff member is assigned — the patient's name, phone and full address | Only their own organization; never booking notes, the medical profile or visit reports (only the assigned staff member, under the provider rules); no access to staff's identity documents or earnings |
| Branch reception (organization staff for one clinic branch) | Today's appointments at their branch only: patient name, appointment time, service, doctor name, status, whether the patient checked in | No phone or address, no medical data, booking notes, visit reports, prices or money; nothing at other branches or on other days; every view, check-in and no-show is logged; access ends the moment the owner removes them |
| Owner of another organization (fallback) | A request offered to them after the original organization's deadline: service, time, area, preferred gender and price | No patient details unless they take it by assigning a staff member; then as above |
| Staff member (nurse / doctor of an organization) | As a provider, for bookings assigned to them by their owner (or accepted from the owner's "send to all") | Can't set their own areas, services or prices; no payouts screen (earnings go to the organization); loses access to a booking and its chat as soon as they're reassigned or removed |
| Other users | A provider's public profile: name, photo, experience, rating, reviews (first name + initial); for doctors with clinic visits, each approved clinic's name, text address and hours (never the clinic phone, which is shown only after booking) | No personal data of patients |
| Reaya+ admin — every role | Dashboard and analytics (counts and totals only, no names), the lists of services and areas | Every action logged |
| Super admin | Everything below, plus admin accounts, settings, the audit log, plans and the service catalog; service announcements to all users | Every action logged; viewing booking notes, dispute descriptions or a booking's chats (including closed ones) is logged |
| Verifier admin | Verification queue: provider and organization identity documents and licences, and clinic licences; provider, organization and user records (read); can suspend a provider's listing | Every action logged; no payments, payouts, chats, booking notes or dispute descriptions |
| Support admin | Users (suspend, warn), bookings with their notes, a booking's chats (including closed ones), disputes with their descriptions, reviews | Every action logged; viewing notes, dispute descriptions or chats is logged; no payments or payouts |
| Finance admin | Payments, refunds, payouts of providers and organizations (with the full payout account number in the payout queue), commission dues, ledger adjustments, financial exports, organizations' commission rates, bookings and disputes for money questions | Every action logged; booking notes and dispute descriptions are hidden from this role; no chats |
| Marketing admin | Promo codes, banners, packages and plan list; marketing broadcasts to a segment (by role and area) with the audience size | Every action logged; sees counts only, never who is in a segment; no bookings, users or payments |
| Automated jobs | Bookings, payments, packages and documents: reminders, expiring requests and unpaid checkouts, weekly payouts, package expiry notices, expiring licenses | No human access |
| Service providers | What the "Where the data is stored" table lists | Bound by their terms; data processing agreements still to be signed |
| Engineers running the servers | Database and backups (encrypted fields stay unreadable without the separate key) | To be restricted to named people; access policy TBD |

## Retention and deletion

Short-lived security data is deleted automatically. Most personal and medical data is currently kept until a retention rule is decided, because "deleting" in the app hides a record rather than erasing it. Financial records are never deleted. Counsel's retention periods will be built in as automatic jobs.

| Data | Kept today | Planned / to decide |
| --- | --- | --- |
| Sign-in codes | Erased 24 hours after they expire (they expire in 2 minutes) | — |
| Sign-in sessions | Erased when they expire (30 days without use) | — |
| Booking-creation copies, queued push messages | 1 day (failed pushes 7 days) | — |
| In-app notifications | Erased after 180 days | — |
| Medical document files | The file is erased when the patient deletes the document; the database entry is hidden and kept | Erase the hidden entry after the retention period |
| Medical records, family profiles, addresses deleted by the user | Hidden from the app, kept in the database | Erase after the retention period |
| Closed accounts | Closed at once: sign-in blocked, sessions and push tokens erased, phone number freed. Name, profile and medical data are kept, hidden. | Planned: anonymise 30 days after closing, keep financial records (job not built yet) |
| Bookings, visit reports, reviews, disputes | Kept; never deleted (medical and financial history) | Retention period for medical records (e.g. a fixed number of years) |
| Chat messages and attachments | Kept with the booking; never deleted, including conversations closed by a reassignment. Push notifications say only that a message arrived, never its text. | Retention period (same question as bookings) |
| Payments, refunds, earnings ledger, payouts, package purchases, patient credit | Kept; never deleted (financial records) | Retention period required by tax / financial rules |
| Payout methods | Kept while the account exists; each payout keeps the destination it was paid to (encrypted) | Period after the provider leaves |
| Cancellation record | Kept with the bookings | Same as bookings |
| Referrals | Kept for the life of the referring account; the phone hash stays so a number can't be referred twice | Period after the accounts close |
| Provider verification documents | Kept while the provider account exists | Period after the provider leaves |
| Organization details and documents | Kept while the organization's account exists | Period after the organization leaves |
| Clinic details and licences | Kept while the clinic exists; a removed clinic is hidden, not erased | Period after the clinic is removed or the doctor leaves |
| Organization statements, plan fees, organization payouts | Kept; never deleted (financial records) | Retention period required by tax / financial rules |
| Staff invites | Invites are valid 7 days. One never accepted (expired, declined or revoked) is deleted — number and name — 30 days after it expired, by a daily job; the organization keeps only an anonymous count. Accepted invites are kept with the staff member's account. | Default pending counsel's answer to question 11 |
| Audit log | Kept indefinitely; cannot be edited | Retention period |
| Consent records and published consent texts | Kept; cannot be edited (evidence of consent) | Retention period after the account closes |
| Backups | Daily; 14 days on the server, long-term copies off-server | Retention and erasure of long-term backups |
| Server log files | Rotated at about 200 MB per service (no fixed period) | Retention period (e.g. 30–90 days) |

An account cannot be closed while it has an active booking. Closing an account does not delete visit reports already given to the patient's record. People can close their account in the app or on a web page (required by Google Play) that confirms the number by SMS code and applies the same rules.

## Questions for counsel

We need these answers before launch; the first two decide where we host.

1. **Hosting location.** May patient and health data be stored on servers outside Egypt (for example in the UAE or Bahrain), and if so, what licence or permission from the Personal Data Protection Center does that require? Or must it stay in Egypt?
2. **Licences and registration.** Which licences, permits or registrations does Reaya+ need as a controller of sensitive (health) data, and does it need a data protection officer?
3. **Consent.** What consent must patients give for their health data, and in what wording (Arabic)? (The app is ready to record it: send the texts for the terms, the privacy notice and the health-data consent, and we publish them as version 1; sign-up then requires them, and later changes ask everyone again.) **Interim rule applied until you answer — please confirm or change:** a patient who withdraws health-data consent keeps their account and can still book, but we stop processing their health data: the medical profile, conditions, medications, allergies and documents of every profile they manage (including family members) are no longer shared with nurses or doctors and can't be edited. The data stays stored, unchanged, and the patient can still view it, with a notice explaining why and how to consent again. Consenting again restores everything. Is this right, and may we keep the stored data while consent is withdrawn? A patient also enters data about family members: what consent is needed from them, and from guardians for children?
4. **Provider identity documents.** Is it allowed to keep copies of national ID cards and licences, and for how long after a nurse or doctor leaves?
5. **Retention periods.** How long must or may we keep: medical records and visit reports, chats, bookings and financial records (payments, payouts, earnings, credit), closed accounts, referral records, the audit log, backups and server logs? Is anonymising a closed account (instead of erasing it) acceptable?
6. **Patient rights.** How quickly must we answer a request to see, correct or delete data, and may we refuse deletion of medical and financial history?
7. **Service providers.** What data processing agreements do we need with the hosting provider, the SMS provider, Paymob (payments), Google (push notifications) and Sentry (error tracking)?
8. **Breach notification.** What are our duties and deadlines if data leaks?
9. **Providers' access.** Is 7 days after a visit an acceptable window for a nurse or doctor to see a patient's medical summary?
10. **Privacy notice.** Review of the privacy policy and terms shown in the app before launch.
11. **Staff invited by organizations.** An owner enters a person's name and mobile number to invite them, and we send that number an SMS. Is the owner's assurance enough, or do we need something more before contacting the person? How long may we keep invites that were never accepted? **Default applied until you answer:** the SMS contains only the organization's name and the app link, and invites not accepted within their 7-day validity are deleted (number and name) 30 days after they expire, keeping only an anonymous count for the organization's statistics. Please confirm or change.
12. **Clinic visits (planned feature).** Doctors will also be bookable for visits at their own clinic, and clinics (nursing or medical centres) can list several branches. Does Reaya+ need any licence, permit or registration of its own (for example from the Ministry of Health) to list clinics and book clinic appointments, beyond each clinic's own licence, which we will verify?
13. **Commission on clinic consultations.** Do the Egyptian Medical Syndicate's rules (for example on doctors' advertising or on sharing consultation fees) limit Reaya+ taking a commission on clinic consultations booked through the app, or how doctors and clinics may be presented in it?
14. **No-show and late-cancellation fees for clinic visits.** If we later charge patients a fee (a percentage of the consultation price) for not showing up or cancelling late, is that allowed for medical consultations, and what must we tell patients beforehand? (At launch the fee is off.)

## Change log

| Date | Milestone | What changed in this inventory |
| --- | --- | --- |
| 8 Oct 2026 | — | First version (patients, nurses, admins). |
| 8 Oct 2026 | M2.1–M2.3 | Doctors; chat (and chat after a reassignment); card and wallet payments through Paymob; travel-fee charges on bookings. |
| 8 Oct 2026 | M2.4 | Payout details (encrypted account numbers, masked for providers); earnings ledger and payout statements; cancellation record per patient; providers paying commission through Paymob. |
| 8 Oct 2026 | M2.5 | Package purchases, promo code use, referrals (phone hashed), in-app credit; banners carry no personal data. |
| 8 Oct 2026 | M3.1 | Organizations: business details, documents, logo, areas and prices; owner and admin access. |
| 8 Oct 2026 | M3.2 | Staff invites (number and name entered by the owner, SMS invitation) and staff records; what owners see about their staff; removal cuts access at once. |
| 8 Oct 2026 | M3.2 | Default for staff invites until question 11 is answered: SMS limited to the organization's name and the app link; never-accepted invites deleted 30 days after expiry, count only. |
| 8 Oct 2026 | M3.3 | Organization bookings: what owners see (operational details; patient name, phone and address after assignment; never notes or medical data); fallback offers to other organizations; staff lose access when reassigned or removed. |
| 8 Oct 2026 | M3.4 | Organization finances: earnings, payouts (encrypted account details), plans billed from earnings, monthly statement PDFs, dashboard and reports (aggregates, no patient names), organizations' own packages. |
| 8 Oct 2026 | M3.4 | Unpaid plan fees are tracked per month (no personal data); an organization unpaid for 21 days is moved to the free plan. |
| 8 Oct 2026 | M3.5 | Admin roles (super admin, verifier, support, finance, marketing) with narrower access — booking notes and dispute descriptions only for super admin and support; admin analytics (aggregates only); broadcasts (marketing ones respect the promotions setting; service announcements always reach everyone, super admin only, with a reason). |
| 8 Oct 2026 | Launch prep | Consent records (versioned texts published by a super admin once counsel provides the wording; acceptances and withdrawals kept with time and IP); test numbers for store reviewers and testers (fixed code, audited, kept apart from real users in production); a web page for account deletion (same sign-in by SMS code, same rules as in the app). |
| 8 Oct 2026 | Launch prep | Interim rule for withdrawn health-data consent: account and bookings continue; health data kept but no longer shared with providers or editable, with a notice to the patient; consenting again restores it (question 3). |
| 8 Oct 2026 | Clinic visits C4 | Organizations' clinic branches (same data as clinics) and the doctors placed there; a new branch reception role (invited by the owner by phone and name, like staff — the SMS carries only the organization's name and the app link) that sees only today's appointments at its branch by patient name and time; branch reports. Still off until launch. |
| 8 Oct 2026 | Clinic visits C3 | Clinic appointments: no home address is collected or shared for them (the booking keeps the clinic's address); the patient sees the clinic phone and a 4-digit visit code once confirmed; the doctor records how the visit was started (with the code, or without it and why — logged). Still off until launch. |
| 8 Oct 2026 | Clinic visits C2 | Patients can find clinics by area and see a clinic's name, text address and hours on the doctor's profile (not its phone). Still off until launch. |
| 8 Oct 2026 | Clinic visits C1 | Clinics: text address, clinic phone, licence scan, hours; reviewed by verifier admins; not yet visible to patients (search and booking come in C2–C3, with the clinic phone shown only after booking). |
| 8 Oct 2026 | Clinic visits (planned) | Questions 12–14 for counsel on clinic visits: platform licensing, commission and syndicate rules, no-show fees. The data changes (clinic addresses and phones, clinic licences, visit-code check-ins, branch reception staff) will be added when the feature is built. |
| 8 Oct 2026 | — | This file became the source of truth (previously a shared online document); a Word copy is generated from it. |
