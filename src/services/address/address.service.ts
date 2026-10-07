import mongoose from 'mongoose';
import { Container, Service } from 'typedi';
import { AddressModel } from '../../database/models/patient/address.model';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/types-errors';
import { BookingModel } from '../../database/models/booking/booking.model';
import { ACTIVE_BOOKING_STATUSES } from '../../interfaces/IBooking';
import { applyPatch } from '../audit/audit.service';
import { LocationService } from '../location/location.service';

export type AddressInput = {
  label: string;
  governorateId: string;
  areaId: string;
  street: string;
  building?: string | null;
  floor?: string | null;
  apartment?: string | null;
  landmark?: string | null;
  notes?: string | null;
};

/**
 * Patient addresses (spec §4.2, §7.5): structured text only, in a bookable area. The first address
 * becomes the default; exactly one default exists while the user has any address.
 */
@Service()
export class AddressService {
  private readonly locations = Container.get(LocationService);

  list(userId: string) {
    return AddressModel.find({ userId }).sort({ isDefault: -1, createdAt: -1 });
  }

  async getOwned(userId: string, id: string) {
    const address = await AddressModel.findOne({ _id: id, userId });
    if (!address) throw new NotFoundError('errors.address_not_found');
    return address;
  }

  async create(userId: string, input: AddressInput, makeDefault = false) {
    await this.assertBookableArea(input.governorateId, input.areaId);
    const isFirst = !(await AddressModel.exists({ userId }));
    const address = await AddressModel.create({ ...input, userId, isDefault: false });
    if (isFirst || makeDefault) await this.setDefault(userId, String(address._id));
    return this.getOwned(userId, String(address._id));
  }

  async update(userId: string, id: string, patch: Partial<AddressInput>) {
    const address = await this.getOwned(userId, id);
    if (patch.areaId || patch.governorateId) {
      await this.assertBookableArea(
        patch.governorateId ?? String(address.governorateId),
        patch.areaId ?? String(address.areaId),
      );
    }
    if (Object.keys(applyPatch(address, patch)).length) await address.save();
    return address;
  }

  /**
   * Deleting the default promotes the most recent remaining address.
   * Refused while an active booking uses the address (spec §7.5).
   */
  async remove(userId: string, id: string) {
    const address = await this.getOwned(userId, id);
    if (await BookingModel.exists({ addressId: address._id, status: { $in: ACTIVE_BOOKING_STATUSES } })) {
      throw new ConflictError('errors.address_in_use');
    }
    const wasDefault = address.isDefault;
    address.isDefault = false;
    await address.softDelete();
    if (wasDefault) {
      const next = await AddressModel.findOne({ userId }).sort({ createdAt: -1 });
      if (next) await this.setDefault(userId, String(next._id));
    }
  }

  /** Atomically moves the default flag (a unique index also guarantees a single default). */
  async setDefault(userId: string, id: string) {
    await this.getOwned(userId, id);
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await AddressModel.updateMany({ userId, isDefault: true }, { isDefault: false }, { session });
        await AddressModel.updateOne({ _id: id, userId }, { isDefault: true }, { session });
      });
    } finally {
      await session.endSession();
    }
    return this.getOwned(userId, id);
  }

  /** New and moved addresses must be in a bookable area, inside the governorate given. */
  private async assertBookableArea(governorateId: string, areaId: string) {
    const area = await this.locations.findBookableArea(areaId);
    if (!area) throw new ValidationError({ area_id: ['validation.area_unavailable'] });
    if (area.governorateId !== governorateId) {
      throw new ValidationError({ governorate_id: ['validation.area_governorate_mismatch'] });
    }
  }
}
