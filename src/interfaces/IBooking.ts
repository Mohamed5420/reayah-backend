import type { Types } from 'mongoose';
import type { PricingUnit } from './enums';

/** Spec §5. */
export enum BookingStatus {
  /** Card / wallet booking not paid yet: hidden from providers; expires after card_payment_window_minutes. */
  AWAITING_PAYMENT = 'awaiting_payment',
  PENDING = 'pending',
  ACCEPTED = 'accepted',
  DECLINED = 'declined',
  EXPIRED = 'expired',
  ON_THE_WAY = 'on_the_way',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
  NO_SHOW = 'no_show',
  DISPUTED = 'disputed',
}

/** Still happening: blocks the provider's time, the address and account deletion. */
export const ACTIVE_BOOKING_STATUSES = [
  BookingStatus.AWAITING_PAYMENT, // holds the provider's slot while the patient pays
  BookingStatus.PENDING,
  BookingStatus.ACCEPTED,
  BookingStatus.ON_THE_WAY,
  BookingStatus.IN_PROGRESS,
];

export enum BookingType {
  HOME_VISIT = 'home_visit',
  VIDEO = 'video',
}

export enum PreferredGender {
  ANY = 'any',
  MALE = 'male',
  FEMALE = 'female',
}

/** direct = one chosen provider; broadcast = offered to several, first to accept wins; organization: Phase 3. */
export enum AssignmentMode {
  DIRECT = 'direct',
  ORGANIZATION = 'organization',
  BROADCAST = 'broadcast',
}

export enum PaymentMethod {
  CASH = 'cash',
  CARD = 'card',
  WALLET = 'wallet',
  /**
   * Nothing left to pay: fully covered by a package and / or credit (M2.5). Set by the server, never
   * chosen by the client; the platform pays the provider their share, like a card booking.
   */
  COVERED = 'covered',
}

/** Paid through the payment gateway (refunds go back there). */
export const GATEWAY_PAYMENT_METHODS = [PaymentMethod.CARD, PaymentMethod.WALLET];

export enum PaymentStatus {
  UNPAID = 'unpaid',
  PENDING = 'pending',
  PAID = 'paid',
  REFUNDED = 'refunded',
  FAILED = 'failed',
}

/** Who moved a booking. `system` = deadline jobs. */
export enum BookingActor {
  PATIENT = 'patient',
  PROVIDER = 'provider',
  ADMIN = 'admin',
  SYSTEM = 'system',
}

/** Price snapshot, piastres (spec §6.3). Fixed when the booking is created. */
export interface IBookingPrice {
  unitPrice: number;
  subtotal: number;
  /** Goes 100% to the provider (decision 10). */
  travelFee: number;
  /** promo + package + credit; all borne by the platform. */
  discount: number;
  /** Missing on bookings made before M2.5 (read through `discountsOf`). */
  discounts?: { promo: number; package: number; credit: number };
  platformFee: number;
  total: number;
  /** Percent of `subtotal` (spec §6.4). */
  commissionRate: number;
  commissionAmount: number;
  /** subtotal − commission + travel fee. */
  providerPayout: number;
}

/** Spec §4.6 `bookings`. Address, service and price are snapshotted so later edits don't change history. */
export interface IBooking {
  _id: Types.ObjectId;
  referenceCode: string;
  patientUserId: Types.ObjectId;
  patientProfileId: Types.ObjectId;
  addressId: Types.ObjectId;
  address: {
    label: string;
    governorateId: Types.ObjectId;
    areaId: Types.ObjectId;
    areaNameAr: string;
    street: string;
    building: string | null;
    floor: string | null;
    apartment: string | null;
    landmark: string | null;
    notes: string | null;
    fullText: string;
  };
  areaId: Types.ObjectId;
  serviceId: Types.ObjectId;
  service: { nameAr: string; nameEn: string | null; pricingUnit: PricingUnit; durationMinutes: number };
  /** null while a broadcast is looking for someone. */
  providerProfileId: Types.ObjectId | null;
  organizationId: Types.ObjectId | null;
  type: BookingType;
  scheduledStart: Date;
  scheduledEnd: Date;
  quantity: number;
  status: BookingStatus;
  preferredGender: PreferredGender;
  assignmentMode: AssignmentMode;
  /** Direct requests: the chosen provider must answer by then (spec §6.9a). Organizations: assign by (Phase 3). */
  assignmentDeadline: Date | null;
  /** Patient agreed to fall back to other providers if the first choice doesn't answer (spec §6.10). */
  allowFallback: boolean;
  /** Broadcast: offers expire and the booking expires at this time. */
  fallbackEndsAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  isOnTime: boolean | null;
  patientNotes: string | null;
  cancellationReason: { code: string; text: string | null } | null;
  /**
   * The patient's travel-fee charge for cancelling after "on the way" or a no-show (settings decide).
   * Card: kept from the refund and credited to the provider. Cash: not collected at launch, recorded so
   * admins can spot repeat cases.
   */
  patientFee: { amount: number; reason: 'late_cancellation' | 'no_show'; collected: boolean } | null;
  /**
   * The patient cancelled an accepted booking within `cancellation_free_window_hours` of the visit,
   * before "on the way": still free, but recorded so admins can see repeat cases.
   */
  lateCancellation: boolean;
  cancelledBy: BookingActor | null;
  price: IBookingPrice;
  currency: 'EGP';
  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
  /** Booked as one visit of this package (spec §4.6). */
  packageSubscriptionId: Types.ObjectId | null;
  /** Promo code used (its use is released if the booking ends without a visit). */
  promo: { promoCodeId: Types.ObjectId; code: string } | null;
  /** When each visit reminder went out (spec §8: 24 h and 1 h before); reset on reschedule. */
  remindersSent: { day: Date | null; hour: Date | null };
  createdAt: Date;
  updatedAt: Date;
}

export enum OfferStatus {
  OFFERED = 'offered',
  ACCEPTED = 'accepted',
  DECLINED = 'declined',
  EXPIRED = 'expired',
  /** Someone else accepted first. */
  LOST = 'lost',
}

/** Spec §4.6 `booking_offers`: one row per provider a broadcast request was sent to. */
export interface IBookingOffer {
  _id: Types.ObjectId;
  bookingId: Types.ObjectId;
  providerProfileId: Types.ObjectId;
  organizationId: Types.ObjectId | null;
  status: OfferStatus;
  offeredAt: Date;
  respondedAt: Date | null;
  expiresAt: Date;
}

/** Spec §4.6 `booking_status_history` — append-only. */
export interface IBookingStatusHistory {
  _id: Types.ObjectId;
  bookingId: Types.ObjectId;
  fromStatus: BookingStatus | null;
  toStatus: BookingStatus;
  actor: BookingActor;
  changedBy: Types.ObjectId | null;
  note: string | null;
  createdAt: Date;
}
