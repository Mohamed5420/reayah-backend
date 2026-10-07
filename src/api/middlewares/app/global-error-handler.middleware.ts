import type { NextFunction, Request, Response } from 'express';
import * as Sentry from '@sentry/node';
import { getRequestId } from '../../../utils/request-context';
import {
  BadRequestError,
  ConflictError,
  HttpError,
  InternalServerError,
  type ErrorFields,
} from '../../../utils/types-errors';
import { resolveLanguage, t, translateIfKey, type Language } from '../../../utils/i18n';
import { logger } from '../../../utils/logger/winston';
import { env } from '../../../config/env.config';

/** body-parser errors (malformed JSON, payload too large) carry their own 4xx status. */
const isBodyParserError = (err: unknown): err is { status: number; type: string } =>
  typeof err === 'object' &&
  err !== null &&
  'type' in err &&
  typeof (err as { status?: unknown }).status === 'number';

/** MongoDB duplicate key (E11000), from a write or a bulk write. */
const isDuplicateKeyError = (err: unknown) =>
  typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000;

const translateFields = (fields: ErrorFields, lang: Language): ErrorFields =>
  Object.fromEntries(
    Object.entries(fields).map(([name, messages]) => [name, messages.map((m) => translateIfKey(m, lang))]),
  );

/**
 * Error envelope (spec §7.0): `{ error: { code, message, fields? } }`, translated to the request language.
 * Unexpected (non-HttpError) errors are logged and reported to Sentry; their details never reach the client in production.
 */
export const GlobalErrorHandlerMiddleware = (
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
) => {
  const lang = resolveLanguage(req);

  if (isBodyParserError(err) && err.status < 500) {
    err = new BadRequestError('errors.malformed_body');
  } else if (isDuplicateKeyError(err)) {
    // A unique index rejected the write (e.g. two areas with the same name in one governorate).
    err = new ConflictError('errors.duplicate');
  }

  if (!(err instanceof HttpError)) {
    logger.error(`Unhandled error on ${req.method} ${req.originalUrl}`, err);
    Sentry.captureException(err, {
      tags: { requestId: getRequestId() },
      extra: { method: req.method, route: req.route?.path ?? req.path },
    });
  }

  const httpError = err instanceof HttpError ? err : new InternalServerError();
  return res
    .status(httpError.statusCode)
    .setHeader('Content-Language', lang)
    .json({
      error: {
        code: httpError.code,
        message: t(httpError.messageKey, httpError.params, lang),
        ...(httpError.fields ? { fields: translateFields(httpError.fields, lang) } : {}),
        ...(!(err instanceof HttpError) && !env.isProduction ? { stack: (err as Error)?.stack } : {}),
      },
    });
};
