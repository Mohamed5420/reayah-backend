import { Container, Service } from 'typedi';
import { ProviderProfileModel } from '../../database/models/provider/provider-profile.model';
import { ProviderDocumentModel } from '../../database/models/provider/provider-document.model';
import { ProviderType, VerificationStatus } from '../../interfaces/enums';
import type { IProviderProfile } from '../../interfaces/IProfiles';
import { DocumentReviewStatus } from '../../interfaces/IProvider';
import { ProviderDocumentService } from './provider-document.service';
import { invalidateCacheNamespace } from '../../utils/cache/cache';
import {
  ConflictError,
  NotFoundError,
  ProviderNotVerifiedError,
  ValidationError,
} from '../../utils/types-errors';
import { applyPatch } from '../audit/audit.service';
import { CatalogService, PROVIDER_PRICES_CACHE } from '../catalog/catalog.service';
import type { SpecialtyKey } from '../catalog/specialties';
import { ClinicService } from '../clinic/clinic.service';
import { isVisitType } from '../catalog/visit-types';
import { BookingType } from '../../interfaces/IBooking';
import { UserModel } from '../../database/models/user/user.model';
import { UserStatus } from '../../interfaces/enums';
import { NotificationType } from '../../interfaces/INotification';
import { NotificationService } from '../notification/notification.service';
import { addDays, cairoDate, cairoToUtc } from '../../utils/time/cairo';

/** Longest pause with an automatic resume. */
const MAX_PAUSE_DAYS = 7;

/** Statuses in which a provider may edit identity fields and (re)submit for verification. */
export const EDITABLE_STATUSES = [
  VerificationStatus.DRAFT,
  VerificationStatus.CHANGES_REQUESTED,
  VerificationStatus.REJECTED,
];

/** Verified by the admin — locked once submitted, until the admin sends the profile back. */
const IDENTITY_FIELDS = ['type', 'licenseNumber', 'syndicateNumber'] as const;

export type ProviderProfileInput = Partial<{
  type: ProviderType;
  specialty: SpecialtyKey | null;
  yearsOfExperience: number;
  bio: string | null;
  languages: string[];
  licenseNumber: string;
  syndicateNumber: string;
}>;

export type OnboardingChecklist = {
  profileCompleted: boolean;
  documentsUploaded: boolean;
  areasSelected: boolean;
  servicesSet: boolean;
  availabilitySet: boolean;
  /** Clinic visits priced → a clinic with a licence and hours (C1). */
  clinicsSet: boolean;
  canSubmit: boolean;
};

/** The signed-in provider's own profile (spec §7.10 "Onboarding & profile"). */
@Service()
export class ProviderProfileService {
  private readonly catalog = Container.get(CatalogService);

  async getOwn(userId: string) {
    const profile = await ProviderProfileModel.findOne({ userId });
    if (!profile) throw new NotFoundError('errors.provider_profile_not_found');
    return profile;
  }

  async update(userId: string, patch: ProviderProfileInput) {
    const profile = await this.getOwn(userId);
    const touchesIdentity = IDENTITY_FIELDS.some(
      (field) => patch[field] !== undefined && patch[field] !== profile.get(field),
    );
    if (touchesIdentity && !EDITABLE_STATUSES.includes(profile.verificationStatus)) {
      throw new ConflictError('errors.profile_locked');
    }

    const typeChanged = patch.type !== undefined && patch.type !== profile.type;
    // A specialty belongs to doctors only (M2.1): required for them by the checklist, refused for nurses.
    const nextType = patch.type ?? profile.type;
    if (patch.specialty && nextType !== ProviderType.DOCTOR) {
      throw new ValidationError({ specialty: ['validation.specialty_doctors_only'] });
    }
    if (nextType !== ProviderType.DOCTOR && profile.specialty) patch = { ...patch, specialty: null };
    if (!Object.keys(applyPatch(profile, patch)).length) return profile;

    if (typeChanged) {
      // Services must match the provider type: drop the ones that no longer do.
      const allowed = new Set(
        (await this.catalog.activeServices({ providerType: profile.type! })).map((s) => s.id),
      );
      profile.services = profile.services.filter((s) => allowed.has(String(s.serviceId)));
    }
    await profile.save();
    if (typeChanged) await invalidateCacheNamespace(PROVIDER_PRICES_CACHE);
    return profile;
  }

  /**
   * PATCH /provider/accepting — only verified providers can take bookings. A pause may carry
   * `resumesAt` ("end_of_day" = the next Cairo midnight; at most 7 days ahead): accepting then turns
   * back on by itself (`resumeDue`). Turning accepting on by hand clears it.
   */
  async setAccepting(userId: string, isAccepting: boolean, resumesAt?: Date | 'end_of_day' | null) {
    const profile = await this.getOwn(userId);
    if (isAccepting && profile.verificationStatus !== VerificationStatus.APPROVED) {
      throw new ProviderNotVerifiedError();
    }
    let resume: Date | null = null;
    if (resumesAt) {
      if (isAccepting) throw new ValidationError({ resumes_at: ['validation.resumes_at_needs_pause'] });
      if (profile.verificationStatus !== VerificationStatus.APPROVED) throw new ProviderNotVerifiedError();
      resume = resumesAt === 'end_of_day' ? cairoToUtc(addDays(cairoDate(), 1), '00:00') : resumesAt;
      if (resume.getTime() <= Date.now())
        throw new ValidationError({ resumes_at: ['validation.in_the_past'] });
      if (resume.getTime() > Date.now() + MAX_PAUSE_DAYS * 24 * 3600_000) {
        throw new ValidationError({ resumes_at: ['validation.resumes_at_too_far'] });
      }
    }
    const changed = profile.isAcceptingBookings !== isAccepting;
    profile.isAcceptingBookings = isAccepting;
    profile.acceptingResumesAt = resume;
    await profile.save();
    if (changed) await invalidateCacheNamespace(PROVIDER_PRICES_CACHE);
    return profile;
  }

  /**
   * Maintenance sweep: pauses whose time has come. Accepting turns back on only for a provider still
   * approved, not suspended by their organization and with an active account; the provider is notified.
   */
  async resumeDue(now = new Date()) {
    const due = await ProviderProfileModel.find({ acceptingResumesAt: { $ne: null, $lte: now } })
      .select('userId verificationStatus staffSuspended isAcceptingBookings')
      .lean();
    let resumed = 0;
    for (const p of due) {
      const user = await UserModel.findById(p.userId).select('status').lean();
      const ok =
        p.verificationStatus === VerificationStatus.APPROVED &&
        !p.staffSuspended &&
        user?.status === UserStatus.ACTIVE;
      const result = await ProviderProfileModel.updateOne(
        { _id: p._id, acceptingResumesAt: { $ne: null, $lte: now } },
        { acceptingResumesAt: null, ...(ok ? { isAcceptingBookings: true } : {}) },
      );
      if (!ok || !result.modifiedCount) continue;
      resumed += 1;
      await Container.get(NotificationService).notify([String(p.userId)], {
        type: NotificationType.ACCOUNT,
        template: 'accepting_resumed',
        data: { is_accepting_bookings: 'true' },
      });
    }
    if (resumed) await invalidateCacheNamespace(PROVIDER_PRICES_CACHE);
    return resumed;
  }

  /** Spec §7.10 `onboarding` block: what's done, and whether the profile can be submitted now. */
  async checklist(profile: IProviderProfile): Promise<OnboardingChecklist> {
    const documents = await ProviderDocumentModel.find({ providerProfileId: profile._id }).lean();
    const usableTypes = new Set(
      documents.filter((d) => d.status !== DocumentReviewStatus.NOT_MATCHING).map((d) => d.type),
    );
    const typeServices = profile.type
      ? new Set((await this.catalog.activeServices({ providerType: profile.type })).map((s) => s.id))
      : new Set<string>();

    // Staff: areas, services and weekly hours are the owner's job, not part of their verification.
    const staff = Boolean(profile.organizationId);
    // Clinic visits (C1): a doctor who only offers clinic visits needs no home areas or hours, but a
    // clinic with a licence and hours.
    const priced = (type: BookingType) =>
      profile.services.some(
        (s) => s.isActive && typeServices.has(String(s.serviceId)) && isVisitType(s, type),
      );
    const home = priced(BookingType.HOME_VISIT);
    const clinic = priced(BookingType.CLINIC_VISIT);
    const clinicOnly = clinic && !home;
    const items = {
      profileCompleted: Boolean(
        profile.type &&
        profile.licenseNumber &&
        profile.syndicateNumber &&
        profile.yearsOfExperience !== null &&
        (profile.type !== ProviderType.DOCTOR || profile.specialty),
      ),
      documentsUploaded: (await Container.get(ProviderDocumentService).requiredTypes()).every((type) =>
        usableTypes.has(type),
      ),
      areasSelected: staff || clinicOnly || profile.serviceAreas.length > 0,
      servicesSet: staff || home || clinic,
      availabilitySet: staff || clinicOnly || profile.availability.length > 0,
      clinicsSet: staff || !clinic || (await Container.get(ClinicService).hasUsableClinic(profile)),
    };
    return {
      ...items,
      canSubmit:
        EDITABLE_STATUSES.includes(profile.verificationStatus) && Object.values(items).every(Boolean),
    };
  }
}
