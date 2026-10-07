import type { ErrorCode } from './error-codes';
import type { TranslationKey, TranslationParams } from '../i18n';

/** Per-field validation messages (translation keys or plain text), e.g. `{ phone: ['validation.invalid_value'] }`. */
export type ErrorFields = Record<string, string[]>;

export type HttpErrorOptions = {
  /** Defaults to `errors.<code>`. */
  messageKey?: TranslationKey;
  params?: TranslationParams;
  fields?: ErrorFields;
};

/**
 * Base class for every error that should reach the client with a specific status code.
 * Carries a translation key, not a final message: the global error handler translates it
 * into the request's language and renders `{ error: { code, message, fields } }`.
 * Anything that is not an HttpError is treated as a 500 INTERNAL_ERROR.
 */
export class HttpError extends Error {
  readonly messageKey: TranslationKey;
  readonly params?: TranslationParams;
  readonly fields?: ErrorFields;

  constructor(
    public readonly statusCode: number,
    public readonly code: ErrorCode,
    { messageKey, params, fields }: HttpErrorOptions = {},
  ) {
    // Typed assignment = compile-time check that every ErrorCode has an `errors.<CODE>` entry in ar.json.
    const key: TranslationKey = messageKey ?? (`errors.${code}` as `errors.${ErrorCode}`);
    super(key);
    this.name = new.target.name;
    this.messageKey = key;
    this.params = params;
    this.fields = fields;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
