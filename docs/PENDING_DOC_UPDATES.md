# Pending updates to the data inventory doc

The "Reaya+ Personal Data Inventory" doc for counsel lives in Claude Docs
(https://claude.ai/code/artifact/c5ee1593-52f1-4bd3-a979-2849f7bbfd98). The Docs connection dropped
during M2.4, so these changes are waiting here. Apply them to the doc as soon as the connection is back,
then delete each item from this file (and the file once it is empty).

## 1. Payout methods — new row in "Data we collect"

| Data | About whom | Examples | Why we need it | Sensitive? |
|---|---|---|---|---|
| Payout details | Nurses and doctors | Account holder name; bank name and IBAN / account number, or mobile-wallet provider and number | Paying out their earnings | Financial (account number encrypted at rest) |

Also:
- **Where it's stored:** main database (`payout_methods`), and a copy on each payout record at the time it was made (`payouts.destination`, encrypted).
- **How it's protected:** account numbers are encrypted (AES-256-GCM). Providers see only the last 4 digits; the full number is shown only to admins in the payout queue (they need it to make the transfer).
- **Who can access:** the provider (masked), admins (full, payout queue only).
- **Retention:** payout records are financial records, kept like payments; the payout method is kept while the account exists.

## 2. Cancellation record — addition to the "Bookings" row and to "Who can access what"

- **Data we collect → Bookings:** add "late cancellations (cancelled within the free-cancellation window before the provider left) and travel-fee charges for cancelling after 'on the way' or a no-show, recorded per patient."
- **Who can access → Reaya+ admin:** "sees each patient's cancellation record (late cancellations, travel-fee charges, uncollected cash charges) on the patient's admin profile."
- **Retention:** kept with the booking (no separate retention).

## 3. Commission payments by providers (added with the commission-limit feature)

- **Data we collect → Card and wallet payments:** "providers paying the commission they owe through Paymob; same data as patient payments (amount, status, Paymob ids, card brand and last 4)."

## 4. Packages, promo codes, referrals and credit (M2.5)

- **Data we collect → new rows:**

| Data | About whom | Examples | Why we need it | Sensitive? |
|---|---|---|---|---|
| Package purchases | Patients (for themselves or a family profile) | Package bought, which patient profile, visits left, start / end dates, the card payment | Delivering prepaid visits | Health-related (the service implies a care need) |
| Promo code use | Patients | Which code, on which booking, the discount | Applying limits (per user, total) | No |
| Referrals | Patients and providers | Who invited whom, a one-way hash of the invited phone number, reward status | Paying referral rewards once per phone number | No (phone stored only as a keyed hash) |
| In-app credit | Patients | Credit earned from referrals, used on / given back from bookings | Applying credit to bookings | Financial |

- **Where it's stored:** main database (`package_subscriptions`, `promo_redemptions`, `referrals`, `wallet_ledger` / `wallet_balances` with owner type "patient").
- **Who can access:** the patient (their packages, credit and referral stats); admins (package sales counts, promo use counts). Providers see only that a visit is covered by a package (the amount to collect).
- **Retention:** package purchases and credit entries are financial records, kept like payments. Referral records are kept for the life of the referring account (the phone hash stays so a number can't be referred twice).
- **Home banners:** marketing images uploaded by admins — no personal data.
