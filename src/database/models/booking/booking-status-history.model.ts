import { Schema, model } from 'mongoose';
import { BookingActor, BookingStatus, type IBookingStatusHistory } from '../../../interfaces/IBooking';

const bookingStatusHistorySchema = new Schema<IBookingStatusHistory>(
  {
    bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true, index: true },
    fromStatus: { type: String, enum: [...Object.values(BookingStatus), null], default: null },
    toStatus: { type: String, enum: Object.values(BookingStatus), required: true },
    actor: { type: String, enum: Object.values(BookingActor), required: true },
    changedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    note: { type: String, default: null },
    /** Internal reason (reassignment): staff and admins only, never in the patient's timeline. */
    internalReason: { type: { code: String, text: String }, default: null, _id: false },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

// Append-only audit trail of every status change (spec §5).
bookingStatusHistorySchema.pre(
  ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace'],
  () => {
    throw new Error('booking_status_history is append-only');
  },
);

export const BookingStatusHistoryModel = model<IBookingStatusHistory>(
  'BookingStatusHistory',
  bookingStatusHistorySchema,
  'booking_status_history',
);
