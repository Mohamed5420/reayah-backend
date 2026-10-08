import { Schema, model } from 'mongoose';
import { OfferStatus, type IBookingOffer } from '../../../interfaces/IBooking';

const bookingOfferSchema = new Schema<IBookingOffer>(
  {
    bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true },
    providerProfileId: { type: Schema.Types.ObjectId, ref: 'ProviderProfile', default: null },
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', default: null },
    status: { type: String, enum: Object.values(OfferStatus), default: OfferStatus.OFFERED },
    offeredAt: { type: Date, default: () => new Date() },
    respondedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false },
);

// One offer per booking and provider, and one per booking and organization (owner-level offers).
bookingOfferSchema.index(
  { bookingId: 1, providerProfileId: 1 },
  { unique: true, partialFilterExpression: { providerProfileId: { $type: 'objectId' } } },
);
bookingOfferSchema.index(
  { bookingId: 1, organizationId: 1 },
  {
    unique: true,
    partialFilterExpression: { providerProfileId: null, organizationId: { $type: 'objectId' } },
  },
);
// GET /provider/offers.
bookingOfferSchema.index({ providerProfileId: 1, status: 1, expiresAt: 1 });
// GET /org/offers.
bookingOfferSchema.index({ organizationId: 1, providerProfileId: 1, status: 1, expiresAt: 1 });

export const BookingOfferModel = model<IBookingOffer>('BookingOffer', bookingOfferSchema, 'booking_offers');
