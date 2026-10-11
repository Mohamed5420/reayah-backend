import { Container, Service } from 'typedi';
import { Types, type HydratedDocument } from 'mongoose';
import { ProviderTimeOffModel } from '../../database/models/provider/provider-time-off.model';
import { CatalogServiceModel } from '../../database/models/catalog/catalog-service.model';
import type { IAvailabilitySlot, IProviderProfile } from '../../interfaces/IProfiles';
import { invalidateCacheNamespace } from '../../utils/cache/cache';
import { NotFoundError, ValidationError, type ErrorFields } from '../../utils/types-errors';
import { CatalogService, PROVIDER_PRICES_CACHE } from '../catalog/catalog.service';
import { LocationService } from '../location/location.service';
import { checkServiceEntries, type ServiceEntryInput } from '../catalog/service-entries';
import { ProviderType } from '../../interfaces/enums';
import { ClinicService } from '../clinic/clinic.service';

type ProfileDoc = HydratedDocument<IProviderProfile>;

const addError = (fields: ErrorFields, key: string, message: string) => {
  (fields[key] ??= []).push(message);
};

/**
 * Where, what and when a provider works (spec §7.10 "Coverage, services & schedule"). Each PUT replaces
 * the whole list, validates every entry, and reports all problems at once (`areas.2.travel_fee`, …).
 */
@Service()
export class ProviderCoverageService {
  private readonly locations = Container.get(LocationService);
  private readonly catalog = Container.get(CatalogService);

  /** Areas must be bookable; travel fees can't exceed the area's admin cap (spec §4.2 `max_travel_fee`). */
  async replaceServiceAreas(profile: ProfileDoc, areas: Array<{ areaId: string; travelFee: number }>) {
    const fields: ErrorFields = {};
    const seen = new Set<string>();
    const found = await Promise.all(areas.map((a) => this.locations.findBookableArea(a.areaId)));
    for (const [i, { areaId, travelFee }] of areas.entries()) {
      if (seen.has(areaId)) addError(fields, `areas.${i}.area_id`, 'validation.duplicate');
      seen.add(areaId);
      const area = found[i];
      if (!area) addError(fields, `areas.${i}.area_id`, 'validation.area_unavailable');
      else if (area.maxTravelFee !== null && travelFee > area.maxTravelFee) {
        addError(fields, `areas.${i}.travel_fee`, 'validation.travel_fee_above_cap');
      }
    }
    if (Object.keys(fields).length) throw new ValidationError(fields);

    profile.set(
      'serviceAreas',
      areas.map((a) => ({ areaId: new Types.ObjectId(a.areaId), travelFee: a.travelFee })),
    );
    await profile.save();
    return profile;
  }

  /**
   * Services must be active, match the provider type, and be priced within the admin bounds for their
   * visit type. A doctor can price a service as a home visit and as a clinic visit (one entry each).
   */
  async replaceServices(profile: ProfileDoc, services: ServiceEntryInput[]) {
    if (!profile.type) throw new ValidationError({ type: ['validation.provider_type_required'] });
    const catalog = new Map(
      (await this.catalog.activeServices({ providerType: profile.type })).map((s) => [s.id, s]),
    );
    const { fields, rows } = checkServiceEntries(services, catalog, {
      clinicAllowed: profile.type === ProviderType.DOCTOR,
    });
    if (Object.keys(fields).length) throw new ValidationError(fields);

    profile.set('services', rows);
    await profile.save();
    await invalidateCacheNamespace(PROVIDER_PRICES_CACHE);
    return profile;
  }

  /** Weekly home-visit hours; slots must not overlap each other or the doctor's clinic hours. */
  async replaceAvailability(
    profile: ProfileDoc,
    slots: IAvailabilitySlot[],
    rules: { breakMinutes?: number; maxVisitsPerDay?: number | null } = {},
  ) {
    Container.get(ClinicService).assertNoOverlap({ availability: [], clinics: profile.clinics }, slots, {
      clinicId: null,
      field: 'slots',
    });
    const fields: ErrorFields = {};
    for (const [i, slot] of slots.entries()) {
      const overlaps = slots.some(
        (other, j) =>
          j < i &&
          other.dayOfWeek === slot.dayOfWeek &&
          other.startTime < slot.endTime &&
          slot.startTime < other.endTime,
      );
      if (overlaps) addError(fields, `slots.${i}`, 'validation.slot_overlap');
    }
    if (Object.keys(fields).length) throw new ValidationError(fields);

    const sorted = [...slots].sort(
      (a, b) => a.dayOfWeek - b.dayOfWeek || a.startTime.localeCompare(b.startTime),
    );
    profile.set('availability', sorted);
    if (rules.breakMinutes !== undefined) profile.breakMinutes = rules.breakMinutes;
    if (rules.maxVisitsPerDay !== undefined) profile.maxVisitsPerDay = rules.maxVisitsPerDay;
    await profile.save();
    return profile;
  }

  /** Current and upcoming time off. */
  listTimeOff(profileId: Types.ObjectId) {
    return ProviderTimeOffModel.find({ providerProfileId: profileId, endsAt: { $gte: new Date() } }).sort({
      startsAt: 1,
    });
  }

  addTimeOff(profileId: Types.ObjectId, input: { startsAt: Date; endsAt: Date; reason?: string | null }) {
    if (input.endsAt <= input.startsAt)
      throw new ValidationError({ ends_at: ['validation.ends_before_starts'] });
    if (input.endsAt <= new Date()) throw new ValidationError({ ends_at: ['validation.in_the_past'] });
    return ProviderTimeOffModel.create({ ...input, providerProfileId: profileId });
  }

  async removeTimeOff(profileId: Types.ObjectId, timeOffId: string) {
    const timeOff = await ProviderTimeOffModel.findOne({ _id: timeOffId, providerProfileId: profileId });
    if (!timeOff) throw new NotFoundError('errors.time_off_not_found');
    await timeOff.softDelete();
  }

  /** Catalog entries for the provider's services, including ones an admin deactivated since. */
  async describeServices(profile: { services: Array<{ serviceId: Types.ObjectId }> }) {
    const ids = profile.services.map((s) => s.serviceId);
    const [services, active] = await Promise.all([
      CatalogServiceModel.find({ _id: { $in: ids } })
        .setOptions({ withDeleted: true })
        .lean(),
      this.catalog.activeServices(),
    ]);
    const activeIds = new Set(active.map((s) => s.id));
    return new Map(
      services.map((s) => [String(s._id), { service: s, available: activeIds.has(String(s._id)) }]),
    );
  }
}
