import { PricingUnit } from '../../interfaces/enums';
import type { IBookingPrice } from '../../interfaces/IBooking';

/**
 * Server-side price (spec §6.3–6.4) — never trust the client:
 *   subtotal = unit price × quantity (per-visit services: × 1)
 *   total    = subtotal + travel fee − discount + platform fee
 *   commission = round(subtotal × rate%)  — on the subtotal only; travel fee goes 100% to the provider
 *   provider payout = subtotal − commission + travel fee
 * Discounts (promos, packages) and the platform fee arrive in Phase 2; both are 0 for now.
 */
export const computePrice = (input: {
  unitPrice: number;
  quantity: number;
  pricingUnit: PricingUnit;
  travelFee: number;
  commissionRate: number;
}): IBookingPrice => {
  const units = input.pricingUnit === PricingUnit.PER_VISIT ? 1 : input.quantity;
  const subtotal = input.unitPrice * units;
  const discount = 0;
  const platformFee = 0;
  const commissionAmount = Math.round((subtotal * input.commissionRate) / 100);
  return {
    unitPrice: input.unitPrice,
    subtotal,
    travelFee: input.travelFee,
    discount,
    platformFee,
    total: subtotal + input.travelFee - discount + platformFee,
    commissionRate: input.commissionRate,
    commissionAmount,
    providerPayout: subtotal - commissionAmount + input.travelFee,
  };
};
