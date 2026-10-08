import { Gender, PricingUnit } from '../../../interfaces/enums';
import {
  BookingStatus,
  BookingType,
  PaymentMethod,
  PaymentStatus,
  PreferredGender,
} from '../../../interfaces/IBooking';
import { objectId, paginationQuery, z } from '../zod';

const instant = z.iso.datetime({ offset: true }).openapi({ example: '2026-10-05T14:00:00Z' });
const money = z.number();
const notes = z.string().trim().max(500).nullable().optional();

const quoteBody = z
  .object({
    service_id: objectId,
    provider_id: objectId.nullable().optional(),
    /** Organizations: Phase 3. */
    organization_id: objectId.nullable().optional(),
    patient_profile_id: objectId,
    address_id: objectId,
    type: z.enum(BookingType).default(BookingType.HOME_VISIT),
    preferred_gender: z.enum(PreferredGender).default(PreferredGender.ANY),
    /** If the provider doesn't answer in time, offer the request to other providers. */
    allow_fallback: z.boolean().default(true),
    scheduled_start: instant,
    quantity: z.number().int().min(1).default(1),
  })
  .openapi('QuoteRequest');

const listItem = z
  .object({
    id: objectId,
    reference_code: z.string(),
    status: z.enum(BookingStatus),
    type: z.enum(BookingType),
    service_name: z.string(),
    scheduled_start: z.string(),
    scheduled_end: z.string(),
    provider_name: z.string().nullable(),
    total: money,
    currency: z.literal('EGP'),
  })
  .openapi('BookingListItem');

const providerItem = z
  .object({
    id: objectId,
    reference_code: z.string(),
    status: z.enum(BookingStatus),
    service_name: z.string(),
    area_name: z.string(),
    scheduled_start: z.string(),
    scheduled_end: z.string(),
    total: money,
    provider_payout: money,
    payment_method: z.enum(PaymentMethod),
  })
  .openapi('ProviderBookingItem');

/** Request and response schemas for /bookings and /provider/bookings (spec §7.8, §7.10). */
export const BookingSchemas = {
  idParams: z.object({ id: objectId }),

  // ── Patient ──
  quoteBody,
  quote: z
    .object({
      subtotal: money,
      travel_fee: money,
      discount: money,
      platform_fee: money,
      total: money,
      currency: z.literal('EGP'),
      lines: z.array(z.object({ label: z.string(), amount: money })),
      cancellation_policy: z.string(),
      /** Valid 10 minutes; guarantees the price. */
      quote_token: z.string(),
      expires_at: z.string(),
    })
    .openapi('Quote'),
  createBody: z
    .object({
      quote_token: z.string().min(1),
      payment_method: z.enum(PaymentMethod).openapi({ description: 'Only `cash` in Phase 1' }),
      patient_notes: notes,
    })
    .openapi('CreateBooking'),
  created: z
    .object({
      id: objectId,
      reference_code: z.string().openapi({ example: 'RY-24A7K3' }),
      status: z.enum(BookingStatus),
      payment_method: z.enum(PaymentMethod),
      payment_status: z.enum(PaymentStatus),
      /** Card / wallet: open checkout_url in a WebView and pay before expires_at. null for cash. */
      payment_action: z
        .object({ payment_id: objectId, checkout_url: z.string(), expires_at: z.string() })
        .nullable(),
    })
    .openapi('BookingCreated'),
  listQuery: paginationQuery.extend({
    status: z.enum(BookingStatus).optional(),
    scope: z.enum(['upcoming', 'past']).default('upcoming'),
  }),
  listItem,
  detail: z
    .object({
      id: objectId,
      reference_code: z.string(),
      type: z.enum(BookingType),
      status: z.enum(BookingStatus),
      service: z.object({ id: objectId, name: z.string() }),
      patient_profile: z.object({ id: objectId }),
      address: z.object({ label: z.string(), full_text: z.string() }),
      scheduled_start: z.string(),
      scheduled_end: z.string(),
      provider: z
        .object({
          id: objectId,
          name: z.string(),
          avatar_url: z.string().nullable(),
          is_verified: z.literal(true),
          rating_avg: z.number(),
          /** Only once the booking is accepted. */
          phone: z.string().nullable(),
        })
        .nullable(),
      price: z.object({
        subtotal: money,
        travel_fee: money,
        discount: money,
        total: money,
        currency: z.literal('EGP'),
      }),
      payment_method: z.enum(PaymentMethod),
      payment_status: z.enum(PaymentStatus),
      timeline: z.array(
        z.object({ status: z.enum(BookingStatus), at: z.string(), note: z.string().nullable() }),
      ),
      can_cancel: z.boolean(),
      can_reschedule: z.boolean(),
      can_review: z.boolean(),
      can_chat: z.boolean(),
      visit_report_id: z.string().nullable(),
      video: z.null(),
    })
    .openapi('BookingDetail'),
  cancelBody: z.object({
    reason_code: z.enum([
      'changed_mind',
      'found_alternative',
      'wrong_time',
      'price',
      'patient_condition',
      'other',
    ]),
    reason_text: notes,
  }),
  cancelled: z.object({ status: z.literal('cancelled'), cancellation_fee: money, refund_amount: money }),
  rescheduleBody: z.object({ scheduled_start: instant }),

  // ── Provider ──
  providerListQuery: paginationQuery.extend({
    status: z.enum(BookingStatus).optional(),
    date: z.iso.date().optional().openapi({ description: 'Cairo date' }),
  }),
  providerItem,
  providerHome: z
    .object({
      today_visits: z.array(providerItem),
      pending_requests: z.array(providerItem),
      open_offers: z.number(),
      today_earnings: money,
      currency: z.literal('EGP'),
    })
    .openapi('ProviderHome'),
  providerDetail: z
    .object({
      id: objectId,
      reference_code: z.string(),
      status: z.enum(BookingStatus),
      type: z.enum(BookingType),
      service: z.object({ name: z.string(), pricing_unit: z.enum(PricingUnit), quantity: z.number() }),
      scheduled_start: z.string(),
      scheduled_end: z.string(),
      /** Hidden (null) while the request is pending. */
      patient: z
        .object({
          full_name: z.string(),
          age: z.number(),
          gender: z.enum(Gender),
          phone: z.string().nullable(),
        })
        .nullable(),
      address: z.object({
        area_name: z.string(),
        /** Hidden (null) while pending. */
        full_text: z.string().nullable(),
        landmark: z.string().nullable(),
        notes: z.string().nullable(),
      }),
      /** Only during the visit and 7 days after (audited). */
      medical_summary: z
        .object({
          conditions: z.array(z.string()),
          medications: z.array(z.string()),
          allergies: z.array(z.string()),
        })
        .nullable(),
      patient_notes: z.string().nullable(),
      price: z.object({ total: money, travel_fee: money, provider_payout: money }),
      payment_method: z.enum(PaymentMethod),
      payment_status: z.enum(PaymentStatus),
      is_on_time: z.boolean().nullable(),
      allowed_actions: z.array(z.string()),
      /** Chat open: from accepted until 24 h after completed. */
      can_chat: z.boolean(),
    })
    .openapi('ProviderBookingDetail'),
  declineBody: z.object({ reason_code: z.enum(['not_available', 'too_far', 'other']) }),
  providerCancelBody: z.object({
    reason_code: z.enum(['emergency', 'patient_request', 'schedule_conflict', 'other']),
    reason_text: notes,
  }),
  offer: z
    .object({
      id: objectId,
      booking_id: objectId,
      service_name: z.string(),
      area_name: z.string(),
      scheduled_start: z.string(),
      scheduled_end: z.string(),
      provider_payout: money,
      expires_at: z.string(),
    })
    .openapi('BookingOffer'),
};
