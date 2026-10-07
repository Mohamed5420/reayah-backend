import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

/**
 * The one zod instance for the app — always import `z` from here, not from 'zod', so that
 * `.openapi(...)` exists and default messages are translation keys.
 */
extendZodWithOpenApi(z);

// Default messages are translation keys (translated by the error handler).
// A schema can still set its own: `z.string({ error: 'validation.phone' })`.
z.config({
  customError: (issue) => (issue.input === undefined ? 'validation.required' : 'validation.invalid_value'),
});

export { z };

export const objectId = z
  .string()
  .regex(/^[0-9a-f]{24}$/i)
  .openapi({ example: '665f1c2b9e1d2a4c3b9e8f1a' });

/** Money in piastres (spec §7.0): `35000` = 350.00 EGP. */
export const piastres = z.number().int().min(0).openapi({ example: 25000 });

/** `?flag=true|false` → boolean. */
export const booleanQuery = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .openapi({ type: 'boolean' });

/** Arabic name (required) / English name (nullable until English launches) — spec §10. */
export const nameAr = z.string().trim().min(2).max(100).openapi({ example: 'مدينة نصر' });
export const nameEn = z.string().trim().min(2).max(100).nullable().openapi({ example: 'Nasr City' });

/** Fields every admin resource returns. */
export const timestamps = { created_at: z.string(), updated_at: z.string() };

/** `?page=&per_page=` (spec §7.0). Read the values with `parsePagination(req.query)`. */
export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).optional().openapi({ example: 1 }),
  per_page: z.coerce.number().int().min(1).max(100).optional().openapi({ example: 20 }),
});
