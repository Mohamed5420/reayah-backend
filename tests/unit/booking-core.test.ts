import { describe, expect, it } from 'vitest';
import { computePrice } from '../../src/services/booking/pricing';
import { canTransition, nextStatuses } from '../../src/services/booking/booking-state';
import { PricingUnit } from '../../src/interfaces/enums';
import { BookingActor, BookingStatus, BookingType } from '../../src/interfaces/IBooking';

describe('computePrice', () => {
  it('per visit: commission on the subtotal only; travel fee goes to the provider', () => {
    expect(
      computePrice({
        unitPrice: 25000,
        quantity: 1,
        pricingUnit: PricingUnit.PER_VISIT,
        travelFee: 3000,
        commissionRate: 15,
      }),
    ).toEqual({
      unitPrice: 25000,
      subtotal: 25000,
      travelFee: 3000,
      discount: 0,
      discounts: { promo: 0, package: 0, credit: 0 },
      platformFee: 0,
      total: 28000,
      commissionRate: 15,
      commissionAmount: 3750,
      providerPayout: 24250,
    });
  });

  it('discounts: promo on the subtotal, package covers it, credit covers what is left; payout unchanged', () => {
    const base = {
      unitPrice: 25000,
      quantity: 1,
      pricingUnit: PricingUnit.PER_VISIT,
      travelFee: 3000,
      commissionRate: 15,
    };
    expect(computePrice({ ...base, promoDiscount: 5000, availableCredit: 2000 })).toMatchObject({
      discount: 7000,
      discounts: { promo: 5000, package: 0, credit: 2000 },
      total: 21000,
      commissionAmount: 3750,
      providerPayout: 24250,
    });
    expect(computePrice({ ...base, coveredByPackage: true, availableCredit: 100000 })).toMatchObject({
      discounts: { promo: 0, package: 25000, credit: 3000 },
      total: 0,
      providerPayout: 24250,
    });
    // A promo never exceeds the subtotal.
    expect(computePrice({ ...base, promoDiscount: 99999 }).discounts).toEqual({
      promo: 25000,
      package: 0,
      credit: 0,
    });
  });

  it('per hour multiplies by quantity; per visit ignores it', () => {
    expect(
      computePrice({
        unitPrice: 10000,
        quantity: 4,
        pricingUnit: PricingUnit.PER_HOUR,
        travelFee: 0,
        commissionRate: 20,
      }),
    ).toMatchObject({ subtotal: 40000, total: 40000, commissionAmount: 8000, providerPayout: 32000 });
    expect(
      computePrice({
        unitPrice: 10000,
        quantity: 4,
        pricingUnit: PricingUnit.PER_VISIT,
        travelFee: 0,
        commissionRate: 20,
      }).subtotal,
    ).toBe(10000);
  });

  it('rounds commission to whole piastres', () => {
    expect(
      computePrice({
        unitPrice: 333,
        quantity: 1,
        pricingUnit: PricingUnit.PER_VISIT,
        travelFee: 0,
        commissionRate: 15,
      }).commissionAmount,
    ).toBe(50);
  });
});

describe('booking state machine', () => {
  const { PATIENT, PROVIDER, SYSTEM } = BookingActor;
  const S = BookingStatus;
  const HOME = BookingType.HOME_VISIT;

  it.each([
    [S.PENDING, S.ACCEPTED, PROVIDER, true],
    [S.PENDING, S.ACCEPTED, PATIENT, false],
    [S.PENDING, S.EXPIRED, SYSTEM, true],
    [S.PENDING, S.IN_PROGRESS, PROVIDER, false],
    [S.ACCEPTED, S.ON_THE_WAY, PROVIDER, true],
    [S.ACCEPTED, S.IN_PROGRESS, PROVIDER, true],
    [S.IN_PROGRESS, S.CANCELLED, PATIENT, false],
    [S.COMPLETED, S.CANCELLED, PATIENT, false],
    [S.CANCELLED, S.ACCEPTED, PROVIDER, false],
  ])('%s → %s by %s: %s', (from, to, actor, allowed) => {
    expect(canTransition(from, to, actor, HOME)).toBe(allowed);
  });

  it('video bookings skip on_the_way', () => {
    expect(canTransition(S.ACCEPTED, S.ON_THE_WAY, PROVIDER, BookingType.VIDEO)).toBe(false);
    expect(nextStatuses(S.ACCEPTED, PROVIDER, BookingType.VIDEO)).not.toContain(S.ON_THE_WAY);
  });

  it('terminal statuses go nowhere', () => {
    for (const status of [S.DECLINED, S.EXPIRED, S.CANCELLED, S.NO_SHOW]) {
      expect(nextStatuses(status, PROVIDER, HOME)).toEqual([]);
    }
  });
});
