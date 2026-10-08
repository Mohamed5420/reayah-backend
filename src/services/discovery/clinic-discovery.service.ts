import { Container, Service } from 'typedi';
import { Types } from 'mongoose';
import { ClinicModel } from '../../database/models/clinic/clinic.model';
import { ProviderProfileModel } from '../../database/models/provider/provider-profile.model';
import { UserModel } from '../../database/models/user/user.model';
import { UserStatus, VerificationStatus } from '../../interfaces/enums';
import { ClinicStatus, type IClinic, type IProviderClinic } from '../../interfaces/IClinic';
import type { IProviderProfile } from '../../interfaces/IProfiles';
import { AreaNotCoveredError, NotFoundError, ValidationError } from '../../utils/types-errors';
import { addDays, cairoDate, cairoToUtc } from '../../utils/time/cairo';
import type { Pagination } from '../../utils/response/pagination';
import { CatalogService, type ServiceRow } from '../catalog/catalog.service';
import { CLINIC_VISIT, offeredEntry, visitTypeMatch } from '../catalog/visit-types';
import { LocationService, type AreaDescription } from '../location/location.service';
import { SettingsService } from '../settings/settings.service';
import { sameWorld } from '../auth/test-accounts';
import { DiscoveryService, compareCards, type ProviderCard, type SearchFilters } from './discovery.service';
import { slotsForDay, type Slot } from './slot-engine';
import { OrganizationModel } from '../../database/models/organization/organization.models';
import type { IOrganization } from '../../interfaces/IOrganization';
import type { OrgCard } from '../organization/org-discovery.service';
import { Gender, ProviderType } from '../../interfaces/enums';
import type { SearchCard } from './discovery.service';

/** Next-free-appointment look-ahead on cards (same as home visits). */
const NEXT_AVAILABLE_DAYS = 7;

/** A bookable place for one doctor: an approved, active clinic with their hours there. */
type ClinicSeat = { profile: Pick<IProviderProfile, '_id'>; link: IProviderClinic };

export type ClinicCardRef = { id: string; name: string; areaId: string };

/**
 * Clinic visits, C2: search, profile clinics and appointment slots. A clinic is bookable when it is
 * approved and active, the feature flag is on, and an approved independent doctor who takes bookings
 * prices the service as a clinic visit and has hours there. Search is by **the clinic's area** and gives
 * one card per (doctor, clinic). Appointments are fixed times of the clinic's length (`slotMinutes`, else
 * the service's duration) inside the doctor's hours there, minus everything on the doctor's one calendar
 * (`DiscoveryService.busyIntervals`: home and clinic bookings and time off alike).
 */
@Service()
export class ClinicDiscoveryService {
  private readonly discovery = Container.get(DiscoveryService);
  private readonly catalog = Container.get(CatalogService);
  private readonly locations = Container.get(LocationService);
  private readonly settings = Container.get(SettingsService);

  async assertEnabled() {
    if (!(await this.settings.get('features')).clinic_visits) {
      throw new ValidationError({ visit_type: ['validation.clinic_visit_not_available'] });
    }
  }

  /** GET /providers?visit_type=clinic_visit — one card per doctor and clinic in the clinic's area. */
  async search(filters: SearchFilters, pagination: Pagination) {
    await this.assertEnabled();
    if (filters.time && !filters.date) throw new ValidationError({ time: ['validation.time_requires_date'] });
    if (filters.date) this.discovery.assertBookableDate(filters.date);
    const service = await this.catalog.getActiveService(filters.serviceId);
    if (!(await this.locations.findBookableArea(filters.areaId))) throw new AreaNotCoveredError();
    const empty = { data: [] as Array<ProviderCard & { kind: 'provider' }>, total: 0, service };
    if (!service.visitTypes.includes(CLINIC_VISIT)) return empty;
    if (filters.providerType && filters.providerType !== service.providerType) return empty;
    const days = filters.date
      ? [filters.date]
      : Array.from({ length: NEXT_AVAILABLE_DAYS }, (_, i) => addDays(cairoDate(), i));
    const wanted = filters.date && filters.time ? cairoToUtc(filters.date, filters.time).getTime() : null;
    const branchCards =
      filters.source === 'independent' ? [] : await this.branchCards(filters, service, days, wanted);

    const clinics =
      filters.source === 'organization'
        ? []
        : await ClinicModel.find({
            areaId: new Types.ObjectId(filters.areaId),
            status: ClinicStatus.APPROVED,
            isActive: true,
            providerProfileId: { $ne: null },
          }).lean();
    if (!clinics.length && !branchCards.length) return empty;

    const priceRange = {
      ...(filters.minPrice !== undefined ? { $gte: filters.minPrice } : {}),
      ...(filters.maxPrice !== undefined ? { $lte: filters.maxPrice } : {}),
    };
    const profiles = await ProviderProfileModel.find({
      _id: { $in: clinics.map((c) => c.providerProfileId) },
      verificationStatus: VerificationStatus.APPROVED,
      isAcceptingBookings: true,
      organizationId: null,
      ...sameWorld(filters.testAccount),
      services: {
        $elemMatch: {
          serviceId: new Types.ObjectId(filters.serviceId),
          isActive: true,
          ...visitTypeMatch(CLINIC_VISIT),
          ...(Object.keys(priceRange).length ? { price: priceRange } : {}),
        },
      },
      ...(filters.specialty ? { specialty: filters.specialty } : {}),
      ...(filters.minRating !== undefined ? { ratingAvg: { $gte: filters.minRating } } : {}),
    })
      // Card fields only: identity fields (licence numbers…) never leave here.
      .select(
        'userId type specialty yearsOfExperience ratingAvg ratingCount completedVisitsCount organizationId availability services clinics',
      )
      .lean();
    const users = await UserModel.find({
      _id: { $in: profiles.map((p) => p.userId) },
      status: UserStatus.ACTIVE,
      ...(filters.gender ? { gender: filters.gender } : {}),
    })
      .select('fullName gender avatarKey')
      .lean();
    const userById = new Map(users.map((u) => [String(u._id), u]));
    const profileById = new Map(profiles.map((p) => [String(p._id), p]));

    const rows: Array<ProviderCard & { kind: 'provider'; clinic: ClinicCardRef; seat: ClinicSeat }> = [];
    for (const clinic of clinics) {
      const profile = profileById.get(String(clinic.providerProfileId));
      const user = profile && userById.get(String(profile.userId));
      const link = profile?.clinics?.find((l) => l.clinicId.equals(clinic._id) && l.hours.length);
      const entry = profile && offeredEntry(profile.services, filters.serviceId, CLINIC_VISIT);
      if (!profile || !user || !link || !entry) continue;
      rows.push({
        kind: 'provider',
        profile,
        user,
        price: entry.price,
        travelFee: 0,
        nextAvailable: null,
        clinic: { id: String(clinic._id), name: clinic.name, areaId: String(clinic.areaId) },
        seat: { profile, link },
      });
    }

    // Next free appointment (on `date`, or within a week); with `date` / `time`, only seats free then.
    const slotsByDay = await this.slotsForSeats(
      rows.map((r) => r.seat),
      service,
      days,
    );
    const visible: SearchCard[] = rows.flatMap((row) => {
      const slots = days.flatMap((d) => slotsByDay.get(seatKey(row.seat))?.get(d) ?? []);
      const free = slots.filter((s) => s.available && (wanted === null || s.start.getTime() === wanted));
      if (filters.date && !free.length) return [];
      return [{ ...row, nextAvailable: free[0]?.start ?? null }];
    });
    visible.push(...branchCards);
    visible.sort(compareCards(filters.sort));
    return {
      data: visible.slice(pagination.skip, pagination.skip + pagination.perPage),
      total: visible.length,
      service,
    };
  }

  /** GET /providers/{id}/slots?visit_type=clinic_visit&clinic_id= — one Cairo date at one clinic. */
  async slots(
    providerId: string,
    input: { serviceId: string; clinicId: string; date: string },
    excludeBookingId?: string,
  ): Promise<Slot[]> {
    await this.assertEnabled();
    this.discovery.assertBookableDate(input.date);
    const { seat, service } = await this.bookableSeat(providerId, input.serviceId, input.clinicId);
    const slots = await this.slotsForSeats([seat], service, [input.date], excludeBookingId);
    return slots.get(seatKey(seat))?.get(input.date) ?? [];
  }

  /**
   * The single eligibility check for a clinic appointment (also for quotes, C3): the clinic is approved,
   * active and the doctor's; the doctor is approved, independent, takes bookings, prices the service as a
   * clinic visit and has hours there.
   */
  async bookableSeat(providerId: string, serviceId: string, clinicId: string) {
    const service = await this.catalog.getActiveService(serviceId);
    const { profile } = await this.discovery.approvedProvider(providerId);
    const clinic = Types.ObjectId.isValid(clinicId)
      ? await ClinicModel.findOne({
          _id: clinicId,
          providerProfileId: profile._id,
          status: ClinicStatus.APPROVED,
          isActive: true,
        }).lean()
      : null;
    const link = clinic && profile.clinics?.find((l) => l.clinicId.equals(clinic._id) && l.hours.length);
    if (!clinic || !link) throw new NotFoundError('errors.clinic_not_found');
    const entry = offeredEntry(profile.services, serviceId, CLINIC_VISIT);
    if (!entry || !service.visitTypes.includes(CLINIC_VISIT))
      throw new NotFoundError('errors.service_not_offered');
    return { profile, clinic, link, entry, service, seat: { profile, link } as ClinicSeat };
  }

  /** The doctor's approved, active clinics with their hours there, for the public profile. */
  async publicClinics(profile: Pick<IProviderProfile, '_id' | 'clinics' | 'services'>) {
    if (!(await this.settings.get('features')).clinic_visits) return [];
    const withHours = (profile.clinics ?? []).filter((l) => l.hours.length);
    if (!withHours.length || !profile.services.some((s) => s.isActive && s.visitType === CLINIC_VISIT))
      return [];
    const clinics = await ClinicModel.find({
      _id: { $in: withHours.map((l) => l.clinicId) },
      providerProfileId: profile._id,
      status: ClinicStatus.APPROVED,
      isActive: true,
    }).lean();
    const places = await this.locations.describeAreas(clinics.map((c) => String(c.areaId)));
    return clinics.map((clinic) => ({
      clinic,
      link: withHours.find((l) => l.clinicId.equals(clinic._id))!,
      place: places.get(String(clinic.areaId)) ?? null,
    }));
  }

  // ── Organization branches (C4) ──

  /**
   * One card per approved, active branch in the area of an approved organization that prices the service
   * as a clinic visit and has at least one doctor there who fits (specialty, gender) — free then, with a
   * date / time. Price = the organization's clinic price; next free = the earliest among its doctors.
   */
  private async branchCards(
    filters: SearchFilters,
    service: ServiceRow,
    days: string[],
    wanted: number | null,
  ): Promise<OrgCard[]> {
    const branches = await ClinicModel.find({
      areaId: new Types.ObjectId(filters.areaId),
      status: ClinicStatus.APPROVED,
      isActive: true,
      organizationId: { $ne: null },
    }).lean();
    if (!branches.length) return [];
    const orgs = await OrganizationModel.find({
      _id: { $in: branches.map((b) => b.organizationId) },
      verificationStatus: VerificationStatus.APPROVED,
      ...sameWorld(filters.testAccount),
    }).lean();
    const cards: OrgCard[] = [];
    for (const branch of branches) {
      const org = orgs.find((o) => o._id.equals(branch.organizationId!));
      const entry = org && offeredEntry(org.services, filters.serviceId, CLINIC_VISIT);
      if (!org || !entry) continue;
      if (filters.minPrice !== undefined && entry.price < filters.minPrice) continue;
      if (filters.maxPrice !== undefined && entry.price > filters.maxPrice) continue;
      const doctors = await this.branchDoctors(org._id, branch._id, {
        gender: filters.gender,
        specialty: filters.specialty,
      });
      if (!doctors.length) continue;
      const slots = await this.slotsForSeats(doctors, service, days);
      const free = doctors
        .flatMap((d) => days.flatMap((day) => slots.get(seatKey(d))?.get(day) ?? []))
        .filter((s) => s.available && (wanted === null || s.start.getTime() === wanted))
        .sort((a, b) => a.start.getTime() - b.start.getTime());
      if (filters.date && !free.length) continue;
      const ratingCount = doctors.reduce((t, d) => t + d.profile.ratingCount, 0);
      const ratingAvg = ratingCount
        ? Math.round(
            (doctors.reduce((t, d) => t + d.profile.ratingAvg * d.profile.ratingCount, 0) / ratingCount) * 10,
          ) / 10
        : 0;
      if (filters.minRating !== undefined && ratingAvg < filters.minRating) continue;
      cards.push({
        kind: 'organization',
        org: { _id: org._id, name: org.name, logoKey: org.logoKey },
        price: entry.price,
        travelFee: 0,
        teamSize: doctors.length,
        ratingAvg,
        ratingCount,
        completedVisits: doctors.reduce((t, d) => t + d.profile.completedVisitsCount, 0),
        nextAvailable: free[0]?.start ?? null,
        clinic: { id: String(branch._id), name: branch.name, areaId: String(branch.areaId) },
      });
    }
    return cards;
  }

  /** Staff doctors placed at a branch who can take appointments (approved, not suspended, accepting). */
  async branchDoctors(
    orgId: Types.ObjectId,
    branchId: Types.ObjectId,
    filter: { gender?: Gender; specialty?: string; doctorId?: string } = {},
  ) {
    const profiles = await ProviderProfileModel.find({
      organizationId: orgId,
      ...(filter.doctorId ? { _id: filter.doctorId } : {}),
      type: ProviderType.DOCTOR,
      verificationStatus: VerificationStatus.APPROVED,
      staffSuspended: false,
      isAcceptingBookings: true,
      clinics: { $elemMatch: { clinicId: branchId, 'hours.0': { $exists: true } } },
      ...(filter.specialty ? { specialty: filter.specialty } : {}),
    })
      .select('userId type specialty ratingAvg ratingCount completedVisitsCount clinics')
      .lean();
    const users = await UserModel.find({
      _id: { $in: profiles.map((p) => p.userId) },
      status: UserStatus.ACTIVE,
      ...(filter.gender ? { gender: filter.gender } : {}),
    })
      .select('fullName gender')
      .lean();
    return profiles.flatMap((profile) => {
      const user = users.find((u) => u._id.equals(profile.userId));
      const link = profile.clinics.find((l) => l.clinicId.equals(branchId));
      return user && link ? [{ profile, user, link }] : [];
    });
  }

  /**
   * A branch appointment can be booked (also the quote check): approved organization and branch (active),
   * clinic price for the service, and a doctor there — the given one, or any.
   */
  async bookableBranch(orgId: string, serviceId: string, branchId: string, doctorId?: string | null) {
    const service = await this.catalog.getActiveService(serviceId);
    const org = Types.ObjectId.isValid(orgId)
      ? await OrganizationModel.findOne({
          _id: orgId,
          verificationStatus: VerificationStatus.APPROVED,
        }).lean()
      : null;
    if (!org) throw new NotFoundError('errors.organization_not_found');
    const branch = Types.ObjectId.isValid(branchId)
      ? await ClinicModel.findOne({
          _id: branchId,
          organizationId: org._id,
          status: ClinicStatus.APPROVED,
          isActive: true,
        }).lean()
      : null;
    if (!branch) throw new NotFoundError('errors.branch_not_found');
    const entry = offeredEntry(org.services, serviceId, CLINIC_VISIT);
    if (!entry || !service.visitTypes.includes(CLINIC_VISIT))
      throw new NotFoundError('errors.service_not_offered');
    const doctors = await this.branchDoctors(org._id, branch._id, { doctorId: doctorId ?? undefined });
    if (!doctors.length)
      throw new NotFoundError(doctorId ? 'errors.staff_not_found' : 'errors.service_not_offered');
    return { org, branch, entry, service, doctors };
  }

  /** Appointment slots at a branch: one doctor's, or the union over its doctors (free when any is). */
  async branchSlots(
    orgId: string,
    input: { serviceId: string; clinicId: string; date: string; doctorId?: string | null },
    excludeBookingId?: string,
  ): Promise<Slot[]> {
    await this.assertEnabled();
    this.discovery.assertBookableDate(input.date);
    const { doctors, service } = await this.bookableBranch(
      orgId,
      input.serviceId,
      input.clinicId,
      input.doctorId,
    );
    const slots = await this.slotsForSeats(doctors, service, [input.date], excludeBookingId);
    const byStart = new Map<number, Slot>();
    for (const d of doctors) {
      for (const s of slots.get(seatKey(d))?.get(input.date) ?? []) {
        const known = byStart.get(s.start.getTime());
        if (!known || (!known.available && s.available)) byStart.set(s.start.getTime(), s);
      }
    }
    return [...byStart.values()].sort((a, b) => a.start.getTime() - b.start.getTime());
  }

  /** Doctors at the branch free for exactly this appointment. */
  async freeDoctorsAt<T extends ClinicSeat>(
    doctors: T[],
    service: ServiceRow,
    start: Date,
    excludeBookingId?: string,
  ) {
    const date = cairoDate(start);
    const slots = await this.slotsForSeats(doctors, service, [date], excludeBookingId);
    return doctors.filter((d) =>
      (slots.get(seatKey(d))?.get(date) ?? []).some(
        (s) => s.available && s.start.getTime() === start.getTime(),
      ),
    );
  }

  /** An organization's approved, active branches for its public profile (clinic visits on). */
  async publicBranches(org: Pick<IOrganization, '_id' | 'services'>) {
    if (!(await this.settings.get('features')).clinic_visits) return [];
    if (!org.services.some((s) => s.isActive && s.visitType === CLINIC_VISIT)) return [];
    const branches = await ClinicModel.find({
      organizationId: org._id,
      status: ClinicStatus.APPROVED,
      isActive: true,
    }).lean();
    const places = await this.locations.describeAreas(branches.map((b) => String(b.areaId)));
    const rows = [];
    for (const branch of branches) {
      const doctors = await this.branchDoctors(org._id, branch._id);
      if (!doctors.length) continue;
      rows.push({ branch, doctors, place: places.get(String(branch.areaId)) ?? null });
    }
    return rows;
  }

  /** Slots per seat and day, with one busy-time query for all of them. */
  private async slotsForSeats(
    seats: ClinicSeat[],
    service: ServiceRow,
    days: string[],
    excludeBookingId?: string,
  ): Promise<Map<string, Map<string, Slot[]>>> {
    const result = new Map<string, Map<string, Slot[]>>();
    if (!seats.length) return result;
    const busy = await this.discovery.busyIntervals(
      seats.map((s) => s.profile._id),
      cairoToUtc(days[0], '00:00'),
      cairoToUtc(addDays(days[days.length - 1], 1), '00:00'),
      excludeBookingId,
    );
    const now = new Date();
    for (const seat of seats) {
      const perDay = new Map<string, Slot[]>();
      for (const day of days) {
        perDay.set(
          day,
          slotsForDay({
            availability: seat.link.hours,
            date: day,
            pricingUnit: service.pricingUnit,
            defaultDurationMinutes: service.defaultDurationMinutes,
            quantity: 1,
            busy: busy.get(String(seat.profile._id)) ?? [],
            now,
            appointmentMinutes: seat.link.slotMinutes ?? service.defaultDurationMinutes,
          }),
        );
      }
      result.set(seatKey(seat), perDay);
    }
    return result;
  }
}

const seatKey = (seat: ClinicSeat) => `${String(seat.profile._id)}:${String(seat.link.clinicId)}`;

export type PublicClinic = { clinic: IClinic; link: IProviderClinic; place: AreaDescription | null };
