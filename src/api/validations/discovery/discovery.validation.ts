import { BannerAction } from '../../../interfaces/IMarketing';
import { Gender, PricingUnit, ProviderType } from '../../../interfaces/enums';
import { ProviderSort } from '../../../services/discovery/discovery.service';
import { objectId, paginationQuery, specialtyView, z } from '../zod';
import { SPECIALTY_KEYS } from '../../../services/catalog/specialties';

const date = z.iso.date().openapi({ example: '2026-10-05', description: 'Cairo calendar date' });
const time = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
  .openapi({ example: '14:00', description: 'Cairo time' });
const money = z.coerce.number().int().min(0);

const providerCard = z
  .object({
    id: objectId,
    name: z.string(),
    avatar_url: z.string().nullable(),
    type: z.enum(ProviderType),
    gender: z.enum(Gender).nullable(),
    is_verified: z.literal(true),
    specialty: specialtyView,
    years_of_experience: z.number().nullable(),
    rating_avg: z.number(),
    rating_count: z.number(),
    completed_visits: z.number(),
    price: z.number(),
    travel_fee: z.number().openapi({ description: 'Added to home visits in the searched area (piastres)' }),
    currency: z.literal('EGP'),
    pricing_unit: z.enum(PricingUnit),
    organization: z.null(),
    next_available: z.string().nullable(),
  })
  .openapi('ProviderCard');

/** Request and response schemas for /home and /providers (spec §7.7). */
export const DiscoverySchemas = {
  idParams: z.object({ id: objectId }),

  searchQuery: paginationQuery.extend({
    service_id: objectId,
    area_id: objectId.openapi({ description: 'From the selected address — matching is by area only' }),
    date: date.optional(),
    time: time.optional(),
    gender: z.enum(Gender).optional().openapi({ description: 'Preferred provider gender (strict filter)' }),
    provider_type: z.enum(ProviderType).optional(),
    /** Doctors with this specialty (keys from GET /specialties). */
    specialty: z.enum(SPECIALTY_KEYS).optional(),
    min_price: money.optional(),
    max_price: money.optional(),
    /** Only providers who can be booked with this package (own price ≤ its per-visit value). */
    package_id: objectId.optional(),
    min_rating: z.coerce.number().min(1).max(5).optional(),
    source: z.enum(['independent', 'organization']).optional(),
    sort: z.enum(ProviderSort).default(ProviderSort.RATING),
  }),
  providerCard,

  providerProfile: z
    .object({
      id: objectId,
      name: z.string(),
      avatar_url: z.string().nullable(),
      type: z.enum(ProviderType),
      gender: z.enum(Gender).nullable(),
      specialty: specialtyView,
      bio: z.string().nullable(),
      years_of_experience: z.number().nullable(),
      is_verified: z.literal(true),
      is_accepting_bookings: z.boolean(),
      rating_avg: z.number(),
      rating_count: z.number(),
      completed_visits: z.number(),
      languages: z.array(z.string()),
      service_areas: z.array(z.object({ id: objectId, name: z.string() })),
      services: z.array(
        z.object({
          service_id: objectId,
          name: z.string(),
          price: z.number(),
          pricing_unit: z.enum(PricingUnit),
        }),
      ),
      organization: z.null(),
      recent_reviews: z.array(
        z.object({
          rating: z.number(),
          comment: z.string().nullable(),
          patient_name: z.string(),
          date: z.string(),
        }),
      ),
    })
    .openapi('ProviderPublicProfile'),

  review: z
    .object({
      rating: z.number(),
      comment: z.string().nullable(),
      patient_name: z.string(),
      date: z.string(),
    })
    .openapi('ProviderReview'),

  slotsQuery: z.object({
    service_id: objectId,
    date,
    quantity: z.coerce.number().int().min(1).default(1),
  }),
  slots: z
    .object({
      date: z.string(),
      slots: z.array(z.object({ start: z.string(), end: z.string(), available: z.boolean() })),
    })
    .openapi('ProviderSlots'),

  home: z
    .object({
      greeting_name: z.string(),
      categories: z.array(
        z.object({ id: objectId, key: z.string(), name: z.string(), icon_url: z.string().nullable() }),
      ),
      upcoming_booking: z
        .object({
          id: objectId,
          status: z.string(),
          service_name: z.string(),
          scheduled_start: z.string(),
          provider_name: z.string().nullable(),
        })
        .nullable(),
      /** The active package that expires first. */
      active_package: z
        .object({
          id: objectId,
          name: z.string(),
          visits_remaining: z.number(),
          expires_at: z.string().nullable(),
        })
        .nullable(),
      banners: z.array(
        z.object({
          id: objectId,
          title: z.string().nullable(),
          /** Signed, valid 10 minutes. */
          image_url: z.string(),
          action: z.enum(BannerAction),
          /** Promo code, service / category / package id, or https link; null for none. */
          value: z.string().nullable(),
        }),
      ),
    })
    .openapi('Home'),
};
