import { Container, Service } from 'typedi';
import { ProviderProfileModel } from '../../database/models/provider/provider-profile.model';
import { ProviderDocumentModel } from '../../database/models/provider/provider-document.model';
import { ProviderType, VerificationStatus } from '../../interfaces/enums';
import type { IProviderProfile } from '../../interfaces/IProfiles';
import { DocumentReviewStatus, REQUIRED_PROVIDER_DOCUMENTS } from '../../interfaces/IProvider';
import { invalidateCacheNamespace } from '../../utils/cache/cache';
import { ConflictError, NotFoundError, ProviderNotVerifiedError } from '../../utils/types-errors';
import { applyPatch } from '../audit/audit.service';
import { CatalogService, PROVIDER_PRICES_CACHE } from '../catalog/catalog.service';

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
  specialty: string | null;
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

  /** PATCH /provider/accepting — only verified providers can take bookings. */
  async setAccepting(userId: string, isAccepting: boolean) {
    const profile = await this.getOwn(userId);
    if (isAccepting && profile.verificationStatus !== VerificationStatus.APPROVED) {
      throw new ProviderNotVerifiedError();
    }
    if (profile.isAcceptingBookings !== isAccepting) {
      profile.isAcceptingBookings = isAccepting;
      await profile.save();
      await invalidateCacheNamespace(PROVIDER_PRICES_CACHE);
    }
    return profile;
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

    const items = {
      profileCompleted: Boolean(
        profile.type &&
        profile.licenseNumber &&
        profile.syndicateNumber &&
        profile.yearsOfExperience !== null &&
        (profile.type !== ProviderType.DOCTOR || profile.specialty),
      ),
      documentsUploaded: REQUIRED_PROVIDER_DOCUMENTS.every((type) => usableTypes.has(type)),
      areasSelected: profile.serviceAreas.length > 0,
      servicesSet: profile.services.some((s) => s.isActive && typeServices.has(String(s.serviceId))),
      availabilitySet: profile.availability.length > 0,
    };
    return {
      ...items,
      canSubmit:
        EDITABLE_STATUSES.includes(profile.verificationStatus) && Object.values(items).every(Boolean),
    };
  }
}
