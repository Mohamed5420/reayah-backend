/** Spec §7.1 OTP rules. */
export const OTP = {
  LENGTH: 4,
  TTL_SECONDS: 120,
  RESEND_AFTER_SECONDS: 60,
  /** Wrong guesses allowed per code before it is burned. */
  MAX_ATTEMPTS: 5,
  /** 3 codes per phone / 10 min. */
  PER_PHONE: { limit: 3, windowSeconds: 10 * 60 },
  /** 10 codes per IP / hour. */
  PER_IP: { limit: 10, windowSeconds: 60 * 60 },
} as const;

/** Short-lived token proving phone ownership between OTP verify and register. */
export const REGISTRATION_TOKEN_TTL_SECONDS = 15 * 60;

/**
 * Egyptian mobile numbers only (+20 10/11/12/15 + 8 digits). Launch is Egypt-only, and restricting
 * OTP to local numbers blocks SMS-pumping fraud to premium international numbers. Widen with care.
 */
export const EGYPT_MOBILE = /^\+201[0125]\d{8}$/;
