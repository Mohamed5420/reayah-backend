import { Container, Service } from 'typedi';
import { Types, type PipelineStage } from 'mongoose';
import { ProviderProfileModel } from '../../database/models/provider/provider-profile.model';
import { ProviderTimeOffModel } from '../../database/models/provider/provider-time-off.model';
import { BookingModel } from '../../database/models/booking/booking.model';
import { ACTIVE_BOOKING_STATUSES } from '../../interfaces/IBooking';
import { UserModel } from '../../database/models/user/user.model';
import { Gender, PricingUnit, ProviderType, UserStatus, VerificationStatus } from '../../interfaces/enums';
import type { IAvailabilitySlot, IProviderProfile } from '../../interfaces/IProfiles';
import type { IUser } from '../../interfaces/IUser';
import { addDays, cairoDate, cairoToUtc } from '../../utils/time/cairo';
import type { Pagination } from '../../utils/response/pagination';
import { AreaNotCoveredError, NotFoundError, ValidationError } from '../../utils/types-errors';
import { CatalogService, type ServiceRow } from '../catalog/catalog.service';
import { LocationService } from '../location/location.service';
import { BOOKING_HORIZON_DAYS, slotsForDay, type Interval, type Slot } from './slot-engine';

export enum ProviderSort {
  RATING = 'rating',
  PRICE_ASC = 'price_asc',
  PRICE_DESC = 'price_desc',
  EXPERIENCE = 'experience',
}

export type SearchFilters = {
  serviceId: string;
  areaId: string;
  /** Cairo date "YYYY-MM-DD": only providers with a free slot that day. */
  date?: string;
  /** "HH:mm" (needs `date`): only providers with a free slot starting then. */
  time?: string;
  gender?: Gender;
  providerType?: ProviderType;
  minPrice?: number;
  maxPrice?: number;
  minRating?: number;
  source?: 'independent' | 'organization';
  sort: ProviderSort;
};

/** One search result: the provider, their user record, and their price / travel fee for this service + area. */
export type ProviderCard = {
  /** Only what a result card needs — identity fields (license etc.) never leave the pipeline. */
  profile: Pick<
    IProviderProfile,
    | '_id'
    | 'type'
    | 'yearsOfExperience'
    | 'ratingAvg'
    | 'ratingCount'
    | 'completedVisitsCount'
    | 'organizationId'
    | 'availability'
  >;
  user: Pick<IUser, '_id' | 'fullName' | 'gender' | 'avatarKey'>;
  price: number;
  travelFee: number;
  nextAvailable: Date | null;
};

/** With a date filter, at most this many matching providers are checked for free slots. */
const DATE_FILTER_CANDIDATES = 500;
/** `next_available` looks this many days ahead. */
const NEXT_AVAILABLE_DAYS = 7;

const SORTS: Record<ProviderSort, Record<string, 1 | -1>> = {
  [ProviderSort.RATING]: { ratingAvg: -1, ratingCount: -1, _id: 1 },
  [ProviderSort.PRICE_ASC]: { price: 1, ratingAvg: -1, _id: 1 },
  [ProviderSort.PRICE_DESC]: { price: -1, ratingAvg: -1, _id: 1 },
  [ProviderSort.EXPERIENCE]: { yearsOfExperience: -1, ratingAvg: -1, _id: 1 },
};

/**
 * Patient-facing discovery (spec §6.1, §7.7). Matching is by area only — never distance (§1):
 * approved + accepting providers who cover the area and offer the service, with an active account.
 */
@Service()
export class DiscoveryService {
  private readonly catalog = Container.get(CatalogService);
  private readonly locations = Container.get(LocationService);

  async search(filters: SearchFilters, pagination: Pagination) {
    if (filters.time && !filters.date) throw new ValidationError({ time: ['validation.time_requires_date'] });
    if (filters.date) this.assertBookableDate(filters.date);
    const service = await this.catalog.getActiveService(filters.serviceId);
    if (!(await this.locations.findBookableArea(filters.areaId))) throw new AreaNotCoveredError();
    if (filters.providerType && filters.providerType !== service.providerType)
      return { data: [], total: 0, service };

    const pipeline = this.searchPipeline(filters);
    let rows: Array<Omit<ProviderCard, 'nextAvailable'>>;
    let total: number;

    if (!filters.date) {
      const [result] = await ProviderProfileModel.aggregate<{
        data: typeof rows;
        total: Array<{ n: number }>;
      }>([
        ...pipeline,
        {
          $facet: {
            data: [{ $skip: pagination.skip }, { $limit: pagination.perPage }],
            total: [{ $count: 'n' }],
          },
        },
      ]);
      rows = result.data;
      total = result.total[0]?.n ?? 0;
    } else {
      // Free-slot filtering needs the schedule, so it happens here, before paginating.
      const candidates = await ProviderProfileModel.aggregate<(typeof rows)[number]>([
        ...pipeline,
        { $limit: DATE_FILTER_CANDIDATES },
      ]);
      const slots = await this.slotsForMany(
        candidates.map((c) => c.profile),
        service,
        filters.date,
        1,
      );
      const free = candidates.filter((c) =>
        (slots.get(String(c.profile._id)) ?? []).some(
          (s) =>
            s.available &&
            (!filters.time || s.start.getTime() === cairoToUtc(filters.date!, filters.time).getTime()),
        ),
      );
      total = free.length;
      rows = free.slice(pagination.skip, pagination.skip + pagination.perPage);
    }

    const next = await this.nextAvailableFor(
      rows.map((r) => r.profile),
      service,
      filters.date,
    );
    return {
      data: rows.map((row) => ({ ...row, nextAvailable: next.get(String(row.profile._id)) ?? null })),
      total,
      service,
    };
  }

  /** Public provider page — approved providers with an active account only. */
  async getPublicProfile(providerId: string) {
    const { profile, user } = await this.approvedProvider(providerId);
    const [places, services] = await Promise.all([
      this.locations.describeAreas(profile.serviceAreas.map((a) => String(a.areaId))),
      this.catalog.activeServices({ providerType: profile.type ?? undefined }),
    ]);
    const catalog = new Map(services.map((s) => [s.id, s]));
    return {
      profile,
      user,
      areas: profile.serviceAreas.flatMap((a) => {
        const place = places.get(String(a.areaId));
        return place?.bookable ? [place.area] : [];
      }),
      services: profile.services.flatMap((s) => {
        const row = catalog.get(String(s.serviceId));
        return s.isActive && row ? [{ service: row, price: s.price }] : [];
      }),
    };
  }

  /** GET /providers/{id}/slots — one Cairo date. */
  /** `excludeBookingId`: ignore that booking's own time (rescheduling it). */
  async providerSlots(
    providerId: string,
    serviceId: string,
    date: string,
    quantity: number,
    excludeBookingId?: string,
  ) {
    this.assertBookableDate(date);
    const { profile } = await this.approvedProvider(providerId);
    const service = await this.catalog.getActiveService(serviceId);
    if (!profile.services.some((s) => s.isActive && String(s.serviceId) === serviceId)) {
      throw new NotFoundError('errors.service_not_offered');
    }
    assertQuantity(service.pricingUnit, quantity);
    return (
      (await this.slotsForMany([profile], service, date, quantity, excludeBookingId)).get(
        String(profile._id),
      ) ?? []
    );
  }

  /**
   * Busy time per provider in [from, to): time off + active bookings (pending direct requests included,
   * so two patients can't request the same slot). The single source for search, slots and booking checks.
   */
  async busyIntervals(
    profileIds: Types.ObjectId[],
    from: Date,
    to: Date,
    excludeBookingId?: string,
  ): Promise<Map<string, Interval[]>> {
    const [timeOff, bookings] = await Promise.all([
      ProviderTimeOffModel.find({
        providerProfileId: { $in: profileIds },
        startsAt: { $lt: to },
        endsAt: { $gt: from },
      }).lean(),
      BookingModel.find({
        providerProfileId: { $in: profileIds },
        status: { $in: ACTIVE_BOOKING_STATUSES },
        scheduledStart: { $lt: to },
        scheduledEnd: { $gt: from },
        ...(excludeBookingId ? { _id: { $ne: excludeBookingId } } : {}),
      })
        .select('providerProfileId scheduledStart scheduledEnd')
        .lean(),
    ]);
    const busy = new Map<string, Interval[]>();
    const add = (id: unknown, interval: Interval) => {
      const key = String(id);
      busy.set(key, [...(busy.get(key) ?? []), interval]);
    };
    for (const t of timeOff) add(t.providerProfileId, { start: t.startsAt, end: t.endsAt });
    for (const b of bookings) add(b.providerProfileId, { start: b.scheduledStart, end: b.scheduledEnd });
    return busy;
  }

  private async slotsForMany(
    profiles: Array<{ _id: Types.ObjectId; availability: IAvailabilitySlot[] }>,
    service: ServiceRow,
    date: string,
    quantity: number,
    excludeBookingId?: string,
  ): Promise<Map<string, Slot[]>> {
    // Busy window: the whole Cairo day plus the longest stay (per-day bookings run past midnight).
    const from = cairoToUtc(date, '00:00');
    const to = cairoToUtc(
      addDays(date, service.pricingUnit === PricingUnit.PER_DAY ? quantity + 1 : 1),
      '00:00',
    );
    const busy = await this.busyIntervals(
      profiles.map((p) => p._id),
      from,
      to,
      excludeBookingId,
    );
    const now = new Date();
    return new Map(
      profiles.map((p) => [
        String(p._id),
        slotsForDay({
          availability: p.availability,
          date,
          pricingUnit: service.pricingUnit,
          defaultDurationMinutes: service.defaultDurationMinutes,
          quantity,
          busy: busy.get(String(p._id)) ?? [],
          now,
        }),
      ]),
    );
  }

  /** Earliest free start per provider: on `date` if given, else within the next 7 days. */
  private async nextAvailableFor(
    profiles: Array<{ _id: Types.ObjectId; availability: IAvailabilitySlot[] }>,
    service: ServiceRow,
    date?: string,
  ): Promise<Map<string, Date>> {
    const result = new Map<string, Date>();
    if (!profiles.length) return result;
    const days = date
      ? [date]
      : Array.from({ length: NEXT_AVAILABLE_DAYS }, (_, i) => addDays(cairoDate(), i));
    // One busy-time query for the whole window, then pure computation per provider and day.
    const busy = await this.busyIntervals(
      profiles.map((p) => p._id),
      cairoToUtc(days[0], '00:00'),
      cairoToUtc(addDays(days[days.length - 1], 2), '00:00'),
    );
    const now = new Date();
    for (const profile of profiles) {
      for (const day of days) {
        const first = slotsForDay({
          availability: profile.availability,
          date: day,
          pricingUnit: service.pricingUnit,
          defaultDurationMinutes: service.defaultDurationMinutes,
          quantity: 1,
          busy: busy.get(String(profile._id)) ?? [],
          now,
        }).find((s) => s.available);
        if (first) {
          result.set(String(profile._id), first.start);
          break;
        }
      }
    }
    return result;
  }

  private searchPipeline(filters: SearchFilters): PipelineStage[] {
    const serviceId = new Types.ObjectId(filters.serviceId);
    const areaId = new Types.ObjectId(filters.areaId);
    const priceRange = {
      ...(filters.minPrice !== undefined ? { $gte: filters.minPrice } : {}),
      ...(filters.maxPrice !== undefined ? { $lte: filters.maxPrice } : {}),
    };
    const pick = (array: string, cond: Record<string, unknown>, field: string) => ({
      $first: { $map: { input: { $filter: { input: array, cond } }, in: `$$this.${field}` } },
    });

    return [
      {
        $match: {
          verificationStatus: VerificationStatus.APPROVED,
          isAcceptingBookings: true,
          'serviceAreas.areaId': areaId,
          services: {
            $elemMatch: {
              serviceId,
              isActive: true,
              ...(Object.keys(priceRange).length ? { price: priceRange } : {}),
            },
          },
          ...(filters.providerType ? { type: filters.providerType } : {}),
          ...(filters.minRating !== undefined ? { ratingAvg: { $gte: filters.minRating } } : {}),
          ...(filters.source === 'independent' ? { organizationId: null } : {}),
          ...(filters.source === 'organization' ? { organizationId: { $ne: null } } : {}),
        },
      },
      {
        $addFields: {
          price: pick(
            '$services',
            { $and: [{ $eq: ['$$this.serviceId', serviceId] }, { $eq: ['$$this.isActive', true] }] },
            'price',
          ),
          travelFee: pick('$serviceAreas', { $eq: ['$$this.areaId', areaId] }, 'travelFee'),
        },
      },
      {
        $lookup: {
          from: UserModel.collection.name,
          localField: 'userId',
          foreignField: '_id',
          as: 'user',
          pipeline: [{ $project: { fullName: 1, gender: 1, avatarKey: 1, status: 1, deletedAt: 1 } }],
        },
      },
      { $unwind: '$user' },
      {
        $match: {
          'user.status': UserStatus.ACTIVE,
          'user.deletedAt': null,
          ...(filters.gender ? { 'user.gender': filters.gender } : {}),
        },
      },
      { $sort: SORTS[filters.sort] },
      // Shape rows as { profile, user, price, travelFee }; never carry encrypted identity fields out.
      {
        $project: {
          _id: 0,
          price: 1,
          travelFee: 1,
          user: { _id: 1, fullName: 1, gender: 1, avatarKey: 1 },
          profile: {
            _id: '$_id',
            type: '$type',
            yearsOfExperience: '$yearsOfExperience',
            ratingAvg: '$ratingAvg',
            ratingCount: '$ratingCount',
            completedVisitsCount: '$completedVisitsCount',
            organizationId: '$organizationId',
            availability: '$availability',
          },
        },
      },
    ];
  }

  private async approvedProvider(providerId: string) {
    const profile = Types.ObjectId.isValid(providerId)
      ? await ProviderProfileModel.findOne({
          _id: providerId,
          verificationStatus: VerificationStatus.APPROVED,
        }).lean()
      : null;
    const user = profile
      ? await UserModel.findOne({ _id: profile.userId, status: UserStatus.ACTIVE }).lean()
      : null;
    if (!profile || !user) throw new NotFoundError('errors.provider_not_found');
    return { profile, user };
  }

  private assertBookableDate(date: string) {
    const today = cairoDate();
    if (date < today || date > addDays(today, BOOKING_HORIZON_DAYS)) {
      throw new ValidationError({ date: ['validation.date_out_of_range'] });
    }
  }
}

/** Per-visit services are booked one at a time; hours up to 12, days up to 30. */
const MAX_QUANTITY: Record<PricingUnit, number> = {
  [PricingUnit.PER_VISIT]: 1,
  [PricingUnit.PER_HOUR]: 12,
  [PricingUnit.PER_DAY]: 30,
};

export const assertQuantity = (unit: PricingUnit, quantity: number) => {
  if (quantity < 1 || quantity > MAX_QUANTITY[unit]) {
    throw new ValidationError({ quantity: ['validation.quantity_out_of_range'] });
  }
};
