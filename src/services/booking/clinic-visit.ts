import { randomInt } from 'node:crypto';
import {
  ACTIVE_BOOKING_STATUSES,
  BookingActor,
  BookingStatus,
  BookingType,
  type IBooking,
} from '../../interfaces/IBooking';
import { BookingModel } from '../../database/models/booking/booking.model';
import { ConflictError } from '../../utils/types-errors';
import { transitionBooking, type BookingTx } from './booking-transaction';

/**
 * Clinic visits (C3). A clinic appointment is confirmed at once when the doctor keeps instant confirmation
 * on (default): the system moves it to accepted right after it is booked (cash / covered) or paid (card /
 * wallet). There is no response deadline and never a fallback to another doctor or address. The patient
 * gets a 4-digit visit code; the doctor enters it to start the visit.
 */
export const isClinicVisit = (booking: Pick<IBooking, 'type'>) => booking.type === BookingType.CLINIC_VISIT;

export const confirmsInstantly = (booking: Pick<IBooking, 'type' | 'clinic'>) =>
  isClinicVisit(booking) && Boolean(booking.clinic?.instantConfirm);

export const newVisitCode = () => String(randomInt(0, 10_000)).padStart(4, '0');

/** Wrong codes allowed before the doctor has to start without it (with a reason). */
export const VISIT_CODE_MAX_ATTEMPTS = 5;

/**
 * Against slot hoarding (instant confirmation + cash + no fees makes it easy). Among the account's clinic
 * appointments that are still active and not over (family members count toward the account):
 * - none may overlap the new one in time;
 * - one upcoming appointment with the same doctor per patient profile;
 * - at most `max` upcoming in total (setting `max_upcoming_clinic_bookings`).
 * `excludeBookingId`: the booking being rescheduled.
 */
export const assertClinicBookingAllowed = async (
  who: { userId: string; patientProfileId: string; providerId: string },
  slot: { start: Date; end: Date },
  max: number,
  excludeBookingId?: string,
) => {
  const upcoming = await BookingModel.find({
    patientUserId: who.userId,
    type: BookingType.CLINIC_VISIT,
    status: { $in: ACTIVE_BOOKING_STATUSES },
    scheduledEnd: { $gt: new Date() },
    ...(excludeBookingId ? { _id: { $ne: excludeBookingId } } : {}),
  })
    .select('patientProfileId providerProfileId scheduledStart scheduledEnd')
    .lean();
  if (upcoming.some((b) => b.scheduledStart < slot.end && slot.start < b.scheduledEnd)) {
    throw new ConflictError('errors.clinic_booking_overlap');
  }
  if (
    upcoming.some(
      (b) =>
        String(b.providerProfileId) === who.providerId && String(b.patientProfileId) === who.patientProfileId,
    )
  ) {
    throw new ConflictError('errors.clinic_same_doctor_limit');
  }
  if (upcoming.length >= max) throw new ConflictError('errors.clinic_booking_limit', { max });
};

/** pending / awaiting_payment → accepted, by the system, for an instant-confirm clinic appointment. */
export const confirmClinicVisit = (tx: BookingTx, booking: IBooking, set: Record<string, unknown> = {}) =>
  transitionBooking(tx, booking, BookingStatus.ACCEPTED, BookingActor.SYSTEM, {
    set: { assignmentDeadline: null, ...set },
    note: 'instant_confirm',
    reason: 'instant_confirm',
  });
