import { PricingUnit, ProviderType } from '../../../interfaces/enums';
import { booleanQuery, nameAr, nameEn, objectId, paginationQuery, piastres, timestamps, z } from '../zod';
import { BookingType } from '../../../interfaces/IBooking';

const providerType = z.enum(ProviderType);
const pricingUnit = z.enum(PricingUnit);
const description = z.string().trim().max(1000).nullable();

const createCategoryBody = z
  .object({
    key: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9_]{1,49}$/)
      .openapi({ example: 'nursing' }),
    name_ar: nameAr,
    name_en: nameEn.optional(),
    icon_url: z.url().nullable().optional(),
    is_active: z.boolean().optional(),
    sort_order: z.number().int().optional(),
  })
  .openapi('CreateServiceCategory');

const createServiceBody = z
  .object({
    category_id: objectId,
    name_ar: nameAr,
    name_en: nameEn.optional(),
    description_ar: description.optional(),
    description_en: description.optional(),
    provider_type: providerType,
    pricing_unit: pricingUnit,
    default_duration_minutes: z
      .number()
      .int()
      .min(5)
      .max(24 * 60),
    min_price: piastres.nullable().optional(),
    max_price: piastres.nullable().optional(),
    /** How the service can be booked (default home only). Clinic visits: doctor services only. */
    visit_types: z
      .array(z.enum([BookingType.HOME_VISIT, BookingType.CLINIC_VISIT]))
      .min(1)
      .optional(),
    /** Clinic-visit price bounds; null = the general ones. */
    clinic_min_price: piastres.nullable().optional(),
    clinic_max_price: piastres.nullable().optional(),
    is_active: z.boolean().optional(),
    sort_order: z.number().int().optional(),
  })
  .openapi('CreateService');

/** Request and response schemas for the service catalog (spec §4.5, §7.3, §7.15). */
export const CatalogSchemas = {
  idParams: z.object({ id: objectId }),

  // ── Public ──
  category: z
    .object({ id: objectId, key: z.string(), name: z.string(), icon_url: z.string().nullable() })
    .openapi('ServiceCategory'),
  servicesQuery: z.object({ category_id: objectId.optional(), provider_type: providerType.optional() }),
  service: z
    .object({
      id: objectId,
      category_id: objectId,
      name: z.string().openapi({ example: 'غيار على جرح' }),
      description: z.string().nullable(),
      provider_type: providerType,
      pricing_unit: pricingUnit,
      default_duration_minutes: z.number(),
      /** home_visit and / or clinic_visit. */
      visit_types: z.array(z.string()),
      /** Lowest active provider price in piastres; null until providers offer the service. */
      starting_price: z.number().nullable(),
      currency: z.literal('EGP'),
    })
    .openapi('Service'),

  // ── Admin ──
  createCategoryBody,
  updateCategoryBody: createCategoryBody.partial().openapi('UpdateServiceCategory'),
  adminCategory: z
    .object({
      id: objectId,
      key: z.string(),
      name_ar: z.string(),
      name_en: z.string().nullable(),
      icon_url: z.string().nullable(),
      is_active: z.boolean(),
      sort_order: z.number(),
      ...timestamps,
    })
    .openapi('AdminServiceCategory'),

  adminServicesQuery: paginationQuery.extend({
    category_id: objectId.optional(),
    provider_type: providerType.optional(),
    is_active: booleanQuery.optional(),
    search: z.string().trim().max(100).optional(),
  }),
  createServiceBody,
  updateServiceBody: createServiceBody.partial().openapi('UpdateService'),
  adminService: z
    .object({
      id: objectId,
      category_id: objectId,
      name_ar: z.string(),
      name_en: z.string().nullable(),
      description_ar: z.string().nullable(),
      description_en: z.string().nullable(),
      provider_type: providerType,
      pricing_unit: pricingUnit,
      default_duration_minutes: z.number(),
      min_price: z.number().nullable(),
      max_price: z.number().nullable(),
      visit_types: z.array(z.string()),
      clinic_min_price: z.number().nullable(),
      clinic_max_price: z.number().nullable(),
      is_active: z.boolean(),
      sort_order: z.number(),
      ...timestamps,
    })
    .openapi('AdminService'),
};
