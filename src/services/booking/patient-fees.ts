import { Container } from 'typedi';
import { GATEWAY_PAYMENT_METHODS, PaymentStatus, type IBooking } from '../../interfaces/IBooking';
import { SettingsService } from '../settings/settings.service';

/**
 * The patient's travel-fee charge (product decision, M2.3 follow-up): no cancellation fee by default,
 * except a cancellation after the provider marked "on the way", or a no-show. Each is a setting. The fee
 * is the booking's travel fee and goes to the provider. A paid card / wallet booking keeps it back from
 * the refund (`collected: true`); a cash booking records it without collecting (`collected: false`).
 */
export const patientFeeFor = async (
  booking: Pick<IBooking, 'price' | 'paymentStatus' | 'paymentMethod'>,
  reason: 'late_cancellation' | 'no_show',
): Promise<IBooking['patientFee']> => {
  const enabled = await Container.get(SettingsService).get(
    reason === 'late_cancellation' ? 'travel_fee_on_late_cancellation' : 'travel_fee_on_no_show',
  );
  if (!enabled || booking.price.travelFee <= 0) return null;
  return {
    amount: booking.price.travelFee,
    reason,
    collected:
      booking.paymentStatus === PaymentStatus.PAID && GATEWAY_PAYMENT_METHODS.includes(booking.paymentMethod),
  };
};
