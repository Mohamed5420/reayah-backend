import type { NextFunction, Request, Response } from 'express';
import type { ZodType } from 'zod';
import { ValidationError, type ErrorFields } from '../../utils/types-errors';

export type RequestSchemas = { params?: ZodType; query?: ZodType; body?: ZodType };

const PARTS = ['params', 'query', 'body'] as const;

/**
 * Validates and parses `params` / `query` / `body` with zod. On success the parsed values replace
 * the raw ones (coerced numbers, defaults, unknown keys stripped). On failure → 422 VALIDATION_ERROR
 * with every invalid input: `{ phone: ['validation.invalid_value'] }` (keys translated by the error handler).
 *
 * Usually not called directly: `defineRoute()` builds it from the route's documented schemas.
 */
export const validate = (schemas: RequestSchemas) => (req: Request, _res: Response, next: NextFunction) => {
  const fields: ErrorFields = {};

  for (const part of PARTS) {
    const schema = schemas[part];
    if (!schema) continue;
    const result = schema.safeParse(req[part] ?? {});
    if (result.success) {
      // `req.query` is a getter in some Express setups; defineProperty works either way.
      Object.defineProperty(req, part, { value: result.data, writable: true, configurable: true });
      continue;
    }
    for (const issue of result.error.issues) {
      // Strict schemas (`z.strictObject`) report extra keys in one issue; name each refused field.
      const entries: Array<[string, string]> =
        issue.code === 'unrecognized_keys'
          ? issue.keys.map((k) => [[...issue.path, k].join('.'), 'validation.unknown_field'])
          : [[issue.path.length ? issue.path.join('.') : part, issue.message]];
      for (const [key, message] of entries) {
        const messages = (fields[key] ??= []);
        if (!messages.includes(message)) messages.push(message);
      }
    }
  }

  if (Object.keys(fields).length) return next(new ValidationError(fields));
  next();
};
