import { Container } from 'typedi';
import {
  BookingType,
  GATEWAY_PAYMENT_METHODS,
  PaymentMethod,
  PaymentStatus,
  type IBooking,
} from '../../interfaces/IBooking';
import { discountsOf } from './pricing';
import { SettingsService } from '../settings/settings.service';

/**
 * The patient's travel-fee charge (product decision, M2.3 follow-up): no cancellation fee by default,
 * except a cancellation after the provider marked "on the way", or a no-show. Each is a setting. The fee
 * is the booking's travel fee and goes to the provider. A paid card / wallet booking keeps it back from
 * the refund (`collected: true`); a cash booking records it without collecting (`collected: false`).
 * A covered booking paid its travel fee with patient credit, so that part of the credit is kept
 * (`collected: true`) and goes to the provider instead of back to the patient (see `settleBenefits`).
 */
export const patientFeeFor = async (
  booking: Pick<IBooking, 'price' | 'paymentStatus' | 'paymentMethod' | 'type'>,
  reason: 'late_cancellation' | 'no_show',
): Promise<IBooking['patientFee']> => {
  const amount =
    booking.type === BookingType.CLINIC_VISIT
      ? await clinicFee(booking, reason)
      : await travelFee(booking, reason);
  if (amount <= 0) return null;
  return {
    amount,
    reason,
    collected:
      (booking.paymentStatus === PaymentStatus.PAID &&
        GATEWAY_PAYMENT_METHODS.includes(booking.paymentMethod)) ||
      (booking.paymentMethod === PaymentMethod.COVERED && discountsOf(booking.price).credit >= amount),
  };
};

const travelFee = async (booking: Pick<IBooking, 'price'>, reason: 'late_cancellation' | 'no_show') => {
  const enabled = await Container.get(SettingsService).get(
    reason === 'late_cancellation' ? 'travel_fee_on_late_cancellation' : 'travel_fee_on_no_show',
  );
  return enabled ? booking.price.travelFee : 0;
};

/** Clinic visits (no journey): a percentage of the consultation price (settings; 0 = none, at launch). */
const clinicFee = async (booking: Pick<IBooking, 'price'>, reason: 'late_cancellation' | 'no_show') => {
  const percent = await Container.get(SettingsService).get(
    reason === 'late_cancellation' ? 'clinic_late_cancellation_fee_percent' : 'clinic_no_show_fee_percent',
  );
  return Math.round((booking.price.subtotal * percent) / 100);
};
