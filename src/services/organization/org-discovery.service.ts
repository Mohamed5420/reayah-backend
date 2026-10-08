import { Container, Service } from 'typedi';
import { Types } from 'mongoose';
import { OrganizationModel } from '../../database/models/organization/organization.models';
import { ProviderProfileModel } from '../../database/models/provider/provider-profile.model';
import { UserModel } from '../../database/models/user/user.model';
import { type Gender, UserStatus, VerificationStatus } from '../../interfaces/enums';
import type { IOrganization } from '../../interfaces/IOrganization';
import type { IProviderProfile } from '../../interfaces/IProfiles';
import type { IUser } from '../../interfaces/IUser';
import { BookingType, type IBooking } from '../../interfaces/IBooking';
import { cairoDate, cairoToUtc } from '../../utils/time/cairo';
import { NotFoundError } from '../../utils/types-errors';
import { CatalogService, type ServiceRow } from '../catalog/catalog.service';
import { DiscoveryService, type SearchFilters } from '../discovery/discovery.service';
import type { Slot } from '../discovery/slot-engine';
import { sameWorld } from '../auth/test-accounts';
import { LocationService } from '../location/location.service';
import { HOME_VISIT, isVisitType, offeredEntry, visitTypeMatch } from '../catalog/visit-types';

export type StaffRow = {
  profile: IProviderProfile;
  user: Pick<IUser, '_id' | 'fullName' | 'gender' | 'avatarKey' | 'isOnline'>;
};

/** One organization in search results (decision: one card per organization; the owner picks who goes). */
export type OrgCard = {
  kind: 'organization';
  org: Pick<IOrganization, '_id' | 'name' | 'logoKey'>;
  price: number;
  travelFee: number;
  /** Staff who could take it: right area, service and preferred gender. */
  teamSize: number;
  /** Weighted over the staff's reviews. */
  ratingAvg: number;
  ratingCount: number;
  completedVisits: number;
  nextAvailable: Date | null;
  /** Clinic-visit cards (C4): the branch this card books. */
  clinic?: { id: string; name: string; areaId: string } | null;
};

/**
 * What patients see of organizations, and which staff can take a request (spec §6.6, §6.10). An
 * organization is available when at least one of its staff — approved, not suspended by the owner,
 * taking bookings, covering the area, offering the service, of the preferred gender — is free.
 */
@Service()
export class OrgDiscoveryService {
  private readonly discovery = Container.get(DiscoveryService);
  private readonly catalog = Container.get(CatalogService);
  private readonly locations = Container.get(LocationService);

  /** Approved organization (patient-facing): 404 otherwise. */
  async approvedOrg(orgId: string) {
    const org = Types.ObjectId.isValid(orgId)
      ? await OrganizationModel.findOne({
          _id: orgId,
          verificationStatus: VerificationStatus.APPROVED,
        }).lean()
      : null;
    if (!org) throw new NotFoundError('errors.organization_not_found');
    return org;
  }

  /** Is this id an approved organization's? (Discovery routes take provider and organization ids alike.) */
  async isOrganization(id: string) {
    return Types.ObjectId.isValid(id) && Boolean(await OrganizationModel.exists({ _id: id }));
  }

  /** Staff who could take a request of this organization. */
  async eligibleStaff(
    orgId: Types.ObjectId | string,
    filter: { serviceId: string; areaId?: string | null; gender?: Gender | null; specialty?: string },
  ): Promise<StaffRow[]> {
    const profiles = await ProviderProfileModel.find({
      organizationId: orgId,
      verificationStatus: VerificationStatus.APPROVED,
      staffSuspended: false,
      isAcceptingBookings: true,
      services: {
        $elemMatch: {
          serviceId: new Types.ObjectId(filter.serviceId),
          isActive: true,
          ...visitTypeMatch(HOME_VISIT),
        },
      },
      ...(filter.areaId ? { 'serviceAreas.areaId': new Types.ObjectId(filter.areaId) } : {}),
      ...(filter.specialty ? { specialty: filter.specialty } : {}),
    }).lean();
    const users = await UserModel.find({
      _id: { $in: profiles.map((p) => p.userId) },
      status: UserStatus.ACTIVE,
      ...(filter.gender ? { gender: filter.gender } : {}),
    })
      .select('fullName gender avatarKey isOnline')
      .lean();
    const byId = new Map(users.map((u) => [String(u._id), u]));
    return profiles.flatMap((profile) => {
      const user = byId.get(String(profile.userId));
      return user ? [{ profile, user }] : [];
    });
  }

  /** Of these staff, who has the slot starting at `start` free (whole duration). */
  async freeAt(
    staff: StaffRow[],
    service: ServiceRow,
    start: Date,
    quantity: number,
    excludeBookingId?: string,
  ) {
    if (!staff.length) return [];
    const slots = await this.discovery.slotsForMany(
      staff.map((s) => s.profile),
      service,
      cairoDate(start),
      quantity,
      excludeBookingId,
    );
    return staff.filter((s) =>
      (slots.get(String(s.profile._id)) ?? []).some(
        (slot) => slot.available && slot.start.getTime() === start.getTime(),
      ),
    );
  }

  /** The organization's slots on a day: free when any eligible staff member is. */
  async slots(
    orgId: string,
    input: {
      serviceId: string;
      date: string;
      quantity: number;
      areaId?: string | null;
      gender?: Gender | null;
      excludeBookingId?: string;
    },
  ): Promise<Slot[]> {
    this.discovery.assertBookableDate(input.date);
    const org = await this.approvedOrg(orgId);
    if (!offeredEntry(org.services, input.serviceId, HOME_VISIT)) {
      throw new NotFoundError('errors.service_not_offered');
    }
    const service = await this.catalog.getActiveService(input.serviceId);
    const staff = await this.eligibleStaff(org._id, input);
    return this.unionSlots(staff, service, input.date, input.quantity, input.excludeBookingId);
  }

  async unionSlots(
    staff: StaffRow[],
    service: ServiceRow,
    date: string,
    quantity: number,
    excludeBookingId?: string,
  ) {
    const perStaff = await this.discovery.slotsForMany(
      staff.map((s) => s.profile),
      service,
      date,
      quantity,
      excludeBookingId,
    );
    const merged = new Map<number, Slot>();
    for (const slots of perStaff.values()) {
      for (const slot of slots) {
        const seen = merged.get(slot.start.getTime());
        if (!seen) merged.set(slot.start.getTime(), { ...slot });
        else if (slot.available) seen.available = true;
      }
    }
    return [...merged.values()].sort((a, b) => a.start.getTime() - b.start.getTime());
  }

  /** Organization cards for a search (spec §6.1; filter `source`). */
  async cards(filters: SearchFilters, service: ServiceRow): Promise<OrgCard[]> {
    const serviceId = new Types.ObjectId(filters.serviceId);
    const areaId = new Types.ObjectId(filters.areaId);
    const priceRange = {
      ...(filters.minPrice !== undefined ? { $gte: filters.minPrice } : {}),
      ...(filters.maxPrice !== undefined ? { $lte: filters.maxPrice } : {}),
    };
    const orgs = await OrganizationModel.find({
      verificationStatus: VerificationStatus.APPROVED,
      ...sameWorld(filters.testAccount),
      serviceAreas: { $elemMatch: { areaId, isActive: true } },
      services: {
        $elemMatch: {
          serviceId,
          isActive: true,
          ...visitTypeMatch(HOME_VISIT),
          ...(Object.keys(priceRange).length ? { price: priceRange } : {}),
        },
      },
    }).lean();
    const area = await this.locations.findBookableArea(filters.areaId);
    const cards: OrgCard[] = [];
    for (const org of orgs) {
      const staff = await this.eligibleStaff(org._id, {
        serviceId: filters.serviceId,
        areaId: filters.areaId,
        gender: filters.gender,
        specialty: filters.specialty,
      });
      if (!staff.length) continue;
      if (filters.date) {
        const slots = await this.unionSlots(staff, service, filters.date, 1);
        const wanted = filters.time ? cairoToUtc(filters.date, filters.time).getTime() : null;
        if (!slots.some((s) => s.available && (wanted === null || s.start.getTime() === wanted))) continue;
      }
      const ratingCount = staff.reduce((t, s) => t + s.profile.ratingCount, 0);
      const ratingAvg = ratingCount
        ? Math.round(
            (staff.reduce((t, s) => t + s.profile.ratingAvg * s.profile.ratingCount, 0) / ratingCount) * 10,
          ) / 10
        : 0;
      if (filters.minRating !== undefined && ratingAvg < filters.minRating) continue;
      const next = await this.discovery.nextAvailableFor(
        staff.map((s) => s.profile),
        service,
        filters.date,
      );
      const earliest = [...next.values()].sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
      const orgArea = org.serviceAreas.find((a) => a.isActive && a.areaId.equals(areaId))!;
      cards.push({
        kind: 'organization',
        org: { _id: org._id, name: org.name, logoKey: org.logoKey },
        price: offeredEntry(org.services, String(serviceId), HOME_VISIT)!.price,
        travelFee: Math.min(orgArea.travelFee, area?.maxTravelFee ?? Infinity),
        teamSize: staff.length,
        ratingAvg,
        ratingCount,
        completedVisits: staff.reduce((t, s) => t + s.profile.completedVisitsCount, 0),
        nextAvailable: earliest,
      });
    }
    return cards;
  }

  /** GET /providers/{id} for an organization: who they are, where they work, what they offer. */
  async publicProfile(orgId: string) {
    const org = await this.approvedOrg(orgId);
    const [places, services, staff] = await Promise.all([
      this.locations.describeAreas(org.serviceAreas.filter((a) => a.isActive).map((a) => String(a.areaId))),
      this.catalog.activeServices(),
      ProviderProfileModel.find({
        organizationId: org._id,
        verificationStatus: VerificationStatus.APPROVED,
        staffSuspended: false,
      })
        .select('ratingAvg ratingCount completedVisitsCount')
        .lean(),
    ]);
    const catalog = new Map(services.map((s) => [s.id, s]));
    const ratingCount = staff.reduce((t, s) => t + s.ratingCount, 0);
    return {
      org,
      areas: org.serviceAreas.flatMap((a) => {
        const place = places.get(String(a.areaId));
        return a.isActive && place?.bookable ? [place.area] : [];
      }),
      services: org.services.flatMap((s) => {
        const row = catalog.get(String(s.serviceId));
        return s.isActive && row && isVisitType(s, HOME_VISIT) ? [{ service: row, price: s.price }] : [];
      }),
      teamSize: staff.length,
      ratingAvg: ratingCount
        ? Math.round((staff.reduce((t, s) => t + s.ratingAvg * s.ratingCount, 0) / ratingCount) * 10) / 10
        : 0,
      ratingCount,
      completedVisits: staff.reduce((t, s) => t + s.completedVisitsCount, 0),
    };
  }

  /** The service as the slot engine needs it — the booking's own snapshot if the catalog entry is gone. */
  async serviceRowFor(booking: Pick<IBooking, 'serviceId' | 'service' | 'quantity'>): Promise<ServiceRow> {
    const active = (await this.catalog.activeServices()).find((s) => s.id === String(booking.serviceId));
    if (active) return active;
    return {
      id: String(booking.serviceId),
      categoryId: '',
      nameAr: booking.service.nameAr,
      nameEn: booking.service.nameEn,
      descriptionAr: null,
      descriptionEn: null,
      providerType: 'nurse' as ServiceRow['providerType'],
      pricingUnit: booking.service.pricingUnit,
      defaultDurationMinutes: booking.service.durationMinutes / Math.max(1, booking.quantity),
      minPrice: null,
      maxPrice: null,
      visitTypes: [BookingType.HOME_VISIT],
      clinicMinPrice: null,
      clinicMaxPrice: null,
    };
  }
}
