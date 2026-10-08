import { HttpError, type ErrorFields } from './http.error';
import { ErrorCode } from './error-codes';
import type { TranslationKey, TranslationParams } from '../i18n';

export { HttpError, ErrorCode, type ErrorFields };

// ── Generic errors: one per status code. Pass a translation key for a more specific message. ──

export class BadRequestError extends HttpError {
  constructor(messageKey?: TranslationKey, params?: TranslationParams) {
    super(400, ErrorCode.BAD_REQUEST, { messageKey, params });
  }
}

export class UnauthorizedError extends HttpError {
  constructor(messageKey?: TranslationKey, params?: TranslationParams) {
    super(401, ErrorCode.UNAUTHENTICATED, { messageKey, params });
  }
}

export class ForbiddenError extends HttpError {
  constructor(messageKey?: TranslationKey, params?: TranslationParams) {
    super(403, ErrorCode.FORBIDDEN, { messageKey, params });
  }
}

export class NotFoundError extends HttpError {
  constructor(messageKey?: TranslationKey, params?: TranslationParams) {
    super(404, ErrorCode.NOT_FOUND, { messageKey, params });
  }
}

export class ConflictError extends HttpError {
  constructor(messageKey?: TranslationKey, params?: TranslationParams) {
    super(409, ErrorCode.CONFLICT, { messageKey, params });
  }
}

export class ValidationError extends HttpError {
  constructor(fields: ErrorFields) {
    super(422, ErrorCode.VALIDATION_ERROR, { fields });
  }
}

export class TooManyRequestsError extends HttpError {
  constructor(messageKey?: TranslationKey) {
    super(429, ErrorCode.RATE_LIMITED, { messageKey });
  }
}

export class InternalServerError extends HttpError {
  constructor() {
    super(500, ErrorCode.INTERNAL_ERROR);
  }
}

export class ServiceUnavailableError extends HttpError {
  constructor(messageKey?: TranslationKey) {
    super(503, ErrorCode.SERVICE_UNAVAILABLE, { messageKey });
  }
}

// ── Domain errors (spec §7.0): one class per code. Message comes from `errors.<CODE>` in the locales. ──

/** Same `Idempotency-Key` sent again with a different request body. */
export class IdempotencyKeyReusedError extends HttpError {
  constructor() {
    super(422, ErrorCode.IDEMPOTENCY_KEY_REUSED);
  }
}

export class TokenExpiredError extends HttpError {
  constructor() {
    super(401, ErrorCode.TOKEN_EXPIRED);
  }
}

export class OtpInvalidError extends HttpError {
  constructor() {
    super(400, ErrorCode.OTP_INVALID);
  }
}

export class OtpExpiredError extends HttpError {
  constructor() {
    super(400, ErrorCode.OTP_EXPIRED);
  }
}

export class OtpMaxAttemptsError extends HttpError {
  constructor() {
    super(429, ErrorCode.OTP_MAX_ATTEMPTS);
  }
}

export class AccountSuspendedError extends HttpError {
  constructor() {
    super(403, ErrorCode.ACCOUNT_SUSPENDED);
  }
}

export class HealthDataConsentWithdrawnError extends HttpError {
  constructor() {
    super(403, ErrorCode.HEALTH_DATA_CONSENT_WITHDRAWN);
  }
}

export class ProviderNotVerifiedError extends HttpError {
  constructor() {
    super(403, ErrorCode.PROVIDER_NOT_VERIFIED);
  }
}

export class SlotUnavailableError extends HttpError {
  constructor() {
    super(409, ErrorCode.SLOT_UNAVAILABLE);
  }
}

export class OfferTakenError extends HttpError {
  constructor() {
    super(409, ErrorCode.OFFER_TAKEN);
  }
}

export class AssignmentDeadlinePassedError extends HttpError {
  constructor() {
    super(409, ErrorCode.ASSIGNMENT_DEADLINE_PASSED);
  }
}

export class InvalidStatusTransitionError extends HttpError {
  constructor() {
    super(409, ErrorCode.INVALID_STATUS_TRANSITION);
  }
}

export class CancellationNotAllowedError extends HttpError {
  constructor() {
    super(409, ErrorCode.CANCELLATION_NOT_ALLOWED);
  }
}

export class AlreadyReviewedError extends HttpError {
  constructor() {
    super(409, ErrorCode.ALREADY_REVIEWED);
  }
}

export class AreaNotCoveredError extends HttpError {
  constructor() {
    super(422, ErrorCode.AREA_NOT_COVERED);
  }
}

export class PromoInvalidError extends HttpError {
  constructor(messageKey?: TranslationKey) {
    super(422, ErrorCode.PROMO_INVALID, { messageKey });
  }
}

export class PromoExpiredError extends HttpError {
  constructor() {
    super(422, ErrorCode.PROMO_EXPIRED);
  }
}

export class PromoLimitReachedError extends HttpError {
  constructor() {
    super(422, ErrorCode.PROMO_LIMIT_REACHED);
  }
}

export class PackageNoVisitsLeftError extends HttpError {
  constructor() {
    super(422, ErrorCode.PACKAGE_NO_VISITS_LEFT);
  }
}

export class PackageExpiredError extends HttpError {
  constructor() {
    super(422, ErrorCode.PACKAGE_EXPIRED);
  }
}

export class PaymentFailedError extends HttpError {
  constructor() {
    super(400, ErrorCode.PAYMENT_FAILED);
  }
}
