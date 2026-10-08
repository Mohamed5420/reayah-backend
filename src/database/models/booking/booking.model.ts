import { Schema, model } from 'mongoose';
import {
  AssignmentMode,
  BookingActor,
  BookingStatus,
  BookingType,
  PaymentMethod,
  PaymentStatus,
  PreferredGender,
  type IBooking,
} from '../../../interfaces/IBooking';
import { PricingUnit } from '../../../interfaces/enums';
import { baseSchemaOptions, piastresValidator } from '../../schema-options';
import { encryptOnWrite } from '../../../utils/crypto/field-encryption';

const money = { type: Number, required: true, validate: piastresValidator };
const text = { type: String, default: null };

/**
 * Bookings are never deleted (they're financial and medical history) — no soft-delete plugin.
 * Status changes go through `transitionBooking()` only.
 */
const bookingSchema = new Schema<IBooking>(
  {
    referenceCode: { type: String, required: true, unique: true },
    patientUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    patientProfileId: { type: Schema.Types.ObjectId, ref: 'PatientProfile', required: true },
    addressId: { type: Schema.Types.ObjectId, ref: 'Address', required: true },
    address: {
      label: { type: String, required: true },
      governorateId: { type: Schema.Types.ObjectId, required: true },
      areaId: { type: Schema.Types.ObjectId, required: true },
      areaNameAr: { type: String, required: true },
      street: { type: String, required: true },
      building: text,
      floor: text,
      apartment: text,
      landmark: text,
      notes: text,
      fullText: { type: String, required: true },
    },
    areaId: { type: Schema.Types.ObjectId, ref: 'Area', required: true },
    serviceId: { type: Schema.Types.ObjectId, ref: 'CatalogService', required: true },
    service: {
      nameAr: { type: String, required: true },
      nameEn: text,
      pricingUnit: { type: String, enum: Object.values(PricingUnit), required: true },
      durationMinutes: { type: Number, required: true },
    },
    providerProfileId: { type: Schema.Types.ObjectId, ref: 'ProviderProfile', default: null },
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', default: null },
    type: { type: String, enum: Object.values(BookingType), required: true },
    scheduledStart: { type: Date, required: true },
    scheduledEnd: { type: Date, required: true },
    quantity: { type: Number, required: true, min: 1 },
    status: { type: String, enum: Object.values(BookingStatus), default: BookingStatus.PENDING },
    preferredGender: { type: String, enum: Object.values(PreferredGender), default: PreferredGender.ANY },
    assignmentMode: { type: String, enum: Object.values(AssignmentMode), required: true },
    assignmentDeadline: { type: Date, default: null },
    deadlineWarningAt: { type: Date, default: null },
    allowFallback: { type: Boolean, default: true },
    fallbackEndsAt: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    isOnTime: { type: Boolean, default: null },
    // May describe the patient's condition: encrypted at rest; decrypted + audited where shown.
    patientNotes: encryptOnWrite({ default: null }),
    cancellationReason: {
      type: new Schema({ code: { type: String, required: true }, text }, { _id: false }),
      default: null,
    },
    cancelledBy: { type: String, enum: [...Object.values(BookingActor), null], default: null },
    lateCancellation: { type: Boolean, default: false },
    patientFee: {
      type: new Schema(
        {
          amount: money,
          reason: { type: String, enum: ['late_cancellation', 'no_show'], required: true },
          collected: { type: Boolean, required: true },
        },
        { _id: false },
      ),
      default: null,
    },
    price: {
      unitPrice: money,
      subtotal: money,
      travelFee: money,
      discount: money,
      discounts: {
        type: new Schema({ promo: money, package: money, credit: money }, { _id: false }),
        default: undefined,
      },
      platformFee: money,
      total: money,
      commissionRate: { type: Number, required: true },
      commissionAmount: money,
      providerPayout: money,
    },
    currency: { type: String, enum: ['EGP'], default: 'EGP' },
    paymentMethod: { type: String, enum: Object.values(PaymentMethod), required: true },
    paymentStatus: { type: String, enum: Object.values(PaymentStatus), default: PaymentStatus.UNPAID },
    packageSubscriptionId: { type: Schema.Types.ObjectId, ref: 'PackageSubscription', default: null },
    promo: {
      type: new Schema(
        {
          promoCodeId: { type: Schema.Types.ObjectId, required: true },
          code: { type: String, required: true },
        },
        { _id: false },
      ),
      default: null,
    },
    remindersSent: {
      day: { type: Date, default: null },
      hour: { type: Date, default: null },
    },
  },
  baseSchemaOptions,
);

bookingSchema.index({ patientUserId: 1, scheduledStart: -1 });
// Busy time per provider + the provider's own lists.
bookingSchema.index({ providerProfileId: 1, status: 1, scheduledStart: 1 });
// Deadline sweep.
bookingSchema.index({ status: 1, assignmentMode: 1, assignmentDeadline: 1 });
bookingSchema.index({ status: 1, fallbackEndsAt: 1 });
// Reminder sweep.
bookingSchema.index({ status: 1, scheduledStart: 1 });

export const BookingModel = model<IBooking>('Booking', bookingSchema);
