import type { Types } from 'mongoose';
import type { IBooking } from '../../interfaces/IBooking';
import { LedgerOwnerType } from '../../interfaces/ILedger';

/**
 * Whose ledger a booking's money lands on (spec §4.8): an organization's booking earns for the
 * organization — never its staff member (spec §2: "earnings go to the organization") — and an
 * independent's for the provider. null while nobody has taken the booking.
 */
export const earningsOwnerOf = (
  booking: Pick<IBooking, 'organizationId' | 'providerProfileId'>,
): { ownerType: LedgerOwnerType; ownerId: Types.ObjectId } | null =>
  booking.organizationId
    ? { ownerType: LedgerOwnerType.ORGANIZATION, ownerId: booking.organizationId }
    : booking.providerProfileId
      ? { ownerType: LedgerOwnerType.PROVIDER, ownerId: booking.providerProfileId }
      : null;
