/**
 * Platform settings (spec §4.10 `settings`, §7.15 PUT /admin/settings). Defaults live in code;
 * the database only stores the values an admin changed. To add a setting: add it to `Settings`,
 * `SETTING_DEFAULTS` and `SETTING_VALIDATORS` — the compiler enforces all three.
 */
export const WEEKDAYS = [
  'saturday',
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface Settings {
  /** Platform commission, percent of `subtotal` (§6.4). Overridable per organization/plan. */
  commission_rate: number;
  /** Organization must assign a booking within this many minutes (§6.6). */
  org_assign_deadline_minutes: number;
  /** Fallback broadcast window before a booking expires (§6.10). */
  fallback_window_minutes: number;
  /** Independent provider must answer a direct request within this many minutes (§6.9a). */
  direct_request_response_minutes: number;
  /** Start within this many minutes of `scheduled_start` counts as on time (§6.13). */
  on_time_grace_minutes: number;
  /** Free cancellation up to this many hours before the visit. */
  cancellation_free_window_hours: number;
  /** Patients can report a problem up to this many hours after the visit (spec §5 `disputed`). */
  dispute_window_hours: number;
  /** Card / wallet bookings wait in awaiting_payment this many minutes, then expire unpaid. */
  card_payment_window_minutes: number;
  /** Patient cancels after the provider marked "on the way" → charged the booking's travel fee (to the provider). */
  travel_fee_on_late_cancellation: boolean;
  /** Provider records a no-show → the patient is charged the booking's travel fee (to the provider). */
  travel_fee_on_no_show: boolean;
  /** Referral credit for each side, piastres. */
  referral_reward: number;
  /** Weekly payout batch day. */
  payout_day: Weekday;
  /** Smallest balance paid out in a batch (piastres); smaller balances roll over to the next week. */
  payout_min_amount: number;
  support_phone: string;
  emergency_number: string;
  min_app_version: { android: string; ios: string };
  features: { video_consult: boolean; card_payment: boolean; packages: boolean };
}

export type SettingKey = keyof Settings;

export const SETTING_DEFAULTS: Settings = {
  commission_rate: 15,
  org_assign_deadline_minutes: 25,
  fallback_window_minutes: 20,
  direct_request_response_minutes: 3,
  on_time_grace_minutes: 15,
  cancellation_free_window_hours: 3,
  dispute_window_hours: 48,
  card_payment_window_minutes: 15,
  travel_fee_on_late_cancellation: true,
  travel_fee_on_no_show: true,
  referral_reward: 5000,
  payout_day: 'thursday',
  payout_min_amount: 10000,
  support_phone: '',
  emergency_number: '123',
  min_app_version: { android: '1.0.0', ios: '1.0.0' },
  features: { video_consult: false, card_payment: false, packages: false },
};

type Validator<T> = (value: unknown) => value is T;

const intBetween =
  (min: number, max: number): Validator<number> =>
  (v): v is number =>
    Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

const isString: Validator<string> = (v): v is string => typeof v === 'string';
const isBoolean: Validator<boolean> = (v): v is boolean => typeof v === 'boolean';
const isVersion: Validator<string> = (v): v is string => typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v);

/** Exact object shape: every key present and valid, no extra keys. */
const shape =
  <T extends object>(validators: { [K in keyof T]: Validator<T[K]> }): Validator<T> =>
  (v): v is T => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
    const keys = Object.keys(validators);
    return (
      Object.keys(v).every((k) => keys.includes(k)) &&
      keys.every((k) => validators[k as keyof T]((v as Record<string, unknown>)[k]))
    );
  };

export const SETTING_VALIDATORS: { [K in SettingKey]: Validator<Settings[K]> } = {
  commission_rate: intBetween(0, 100),
  org_assign_deadline_minutes: intBetween(1, 24 * 60),
  fallback_window_minutes: intBetween(1, 24 * 60),
  direct_request_response_minutes: intBetween(1, 24 * 60),
  on_time_grace_minutes: intBetween(0, 24 * 60),
  cancellation_free_window_hours: intBetween(0, 7 * 24),
  dispute_window_hours: intBetween(1, 30 * 24),
  card_payment_window_minutes: intBetween(5, 24 * 60),
  travel_fee_on_late_cancellation: isBoolean,
  travel_fee_on_no_show: isBoolean,
  referral_reward: intBetween(0, 10_000_000),
  payout_day: (v): v is Weekday => WEEKDAYS.includes(v as Weekday),
  payout_min_amount: intBetween(0, 100_000_00),
  support_phone: isString,
  emergency_number: isString,
  min_app_version: shape<Settings['min_app_version']>({ android: isVersion, ios: isVersion }),
  features: shape<Settings['features']>({
    video_consult: isBoolean,
    card_payment: isBoolean,
    packages: isBoolean,
  }),
};

export const isSettingKey = (key: string): key is SettingKey => key in SETTING_DEFAULTS;
