import { booleanQuery, nameAr, nameEn, objectId, paginationQuery, piastres, timestamps, z } from '../zod';

const createGovernorateBody = z
  .object({
    name_ar: nameAr,
    name_en: nameEn.optional(),
    is_active: z.boolean().optional(),
    sort_order: z.number().int().optional(),
  })
  .openapi('CreateGovernorate');

const createAreaBody = z
  .object({
    governorate_id: objectId,
    name_ar: nameAr,
    name_en: nameEn.optional(),
    is_active: z.boolean().optional(),
    /** Admin cap on travel fees in this area; null removes the cap. */
    max_travel_fee: piastres.nullable().optional(),
  })
  .openapi('CreateArea');

const area = z.object({ id: objectId, name: z.string(), governorate_id: objectId }).openapi('Area');

/** Request and response schemas for locations (spec §4.2, §7.3, §7.15). */
export const LocationSchemas = {
  idParams: z.object({ id: objectId }),

  // ── Public ──
  governorate: z.object({ id: objectId, name: z.string() }).openapi('Governorate'),
  area,
  areaSearchQuery: paginationQuery.extend({
    search: z.string().trim().max(100).optional().openapi({ example: 'نصر' }),
    governorate_id: objectId.optional(),
  }),
  areaSearchResult: area.extend({ governorate_name: z.string() }).openapi('AreaSearchResult'),

  // ── Admin ──
  adminGovernorateQuery: paginationQuery.extend({
    is_active: booleanQuery.optional(),
    search: z.string().trim().max(100).optional(),
  }),
  createGovernorateBody,
  updateGovernorateBody: createGovernorateBody.partial().openapi('UpdateGovernorate'),
  adminGovernorate: z
    .object({
      id: objectId,
      name_ar: z.string(),
      name_en: z.string().nullable(),
      is_active: z.boolean(),
      sort_order: z.number(),
      ...timestamps,
    })
    .openapi('AdminGovernorate'),

  adminAreaQuery: paginationQuery.extend({
    governorate_id: objectId.optional(),
    is_active: booleanQuery.optional(),
    search: z.string().trim().max(100).optional(),
  }),
  createAreaBody,
  updateAreaBody: createAreaBody.partial().openapi('UpdateArea'),
  adminArea: z
    .object({
      id: objectId,
      governorate_id: objectId,
      name_ar: z.string(),
      name_en: z.string().nullable(),
      is_active: z.boolean(),
      max_travel_fee: z.number().nullable(),
      ...timestamps,
    })
    .openapi('AdminArea'),
};
