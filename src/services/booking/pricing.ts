import { PricingUnit } from '../../interfaces/enums';
import type { IBookingPrice } from '../../interfaces/IBooking';

/**
 * Server-side price (spec §6.3–6.4) — never trust the client:
 *   subtotal = unit price × quantity (per-visit services: × 1)
 *   discount = promo + package coverage + patient credit
 *   total    = subtotal + travel fee − discount + platform fee
 *   commission = round(subtotal × rate%)  — on the subtotal only; travel fee goes 100% to the provider
 *   provider payout = subtotal − commission + travel fee
 * Discounts are borne by the platform (product decision, M2.5): the provider's payout never changes.
 * The promo applies to the subtotal, a package covers the subtotal, and credit covers whatever is left
 * (travel fee included). The platform fee is 0 for now.
 */
export const computePrice = (input: {
  unitPrice: number;
  quantity: number;
  pricingUnit: PricingUnit;
  travelFee: number;
  commissionRate: number;
  promoDiscount?: number;
  /** A package visit covers the subtotal. */
  coveredByPackage?: boolean;
  /** The patient's credit balance; as much as needed is used. */
  availableCredit?: number;
}): IBookingPrice => {
  const units = input.pricingUnit === PricingUnit.PER_VISIT ? 1 : input.quantity;
  const subtotal = input.unitPrice * units;
  const platformFee = 0;
  const packageCoverage = input.coveredByPackage ? subtotal : 0;
  const promo = Math.min(input.promoDiscount ?? 0, subtotal - packageCoverage);
  const beforeCredit = subtotal + input.travelFee + platformFee - packageCoverage - promo;
  const credit = Math.max(0, Math.min(input.availableCredit ?? 0, beforeCredit));
  const discount = promo + packageCoverage + credit;
  const commissionAmount = Math.round((subtotal * input.commissionRate) / 100);
  return {
    unitPrice: input.unitPrice,
    subtotal,
    travelFee: input.travelFee,
    discount,
    discounts: { promo, package: packageCoverage, credit },
    platformFee,
    total: subtotal + input.travelFee - discount + platformFee,
    commissionRate: input.commissionRate,
    commissionAmount,
    providerPayout: subtotal - commissionAmount + input.travelFee,
  };
};

/** Breakdown of `price.discount`; bookings made before M2.5 have none. */
export const discountsOf = (price: IBookingPrice) => ({
  promo: price.discounts?.promo ?? 0,
  package: price.discounts?.package ?? 0,
  credit: price.discounts?.credit ?? 0,
});
