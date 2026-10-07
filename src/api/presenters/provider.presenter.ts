import type { IUser } from '../../interfaces/IUser';
import type { IAvailabilitySlot, IProviderProfile } from '../../interfaces/IProfiles';
import type { IProviderDocument, IProviderTimeOff } from '../../interfaces/IProvider';
import type { ICatalogService } from '../../interfaces/ICatalog';
import type { AreaDescription } from '../../services/location';
import type { OnboardingChecklist } from '../../services/provider';
import type { Language } from '../../utils/i18n';
import { localized } from './localize';
import { presentSpecialty } from '../../services/catalog/specialties';

/** Maps provider data to the API shapes in provider.validation.ts. */

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const dateOnly = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

export const presentChecklist = (c: OnboardingChecklist) => ({
  profile_completed: c.profileCompleted,
  documents_uploaded: c.documentsUploaded,
  areas_selected: c.areasSelected,
  services_set: c.servicesSet,
  availability_set: c.availabilitySet,
  can_submit: c.canSubmit,
});

const profileFields = (p: IProviderProfile) => ({
  id: String(p._id),
  type: p.type,
  specialty: presentSpecialty(p.specialty),
  years_of_experience: p.yearsOfExperience,
  bio: p.bio,
  languages: p.languages,
  license_number: p.licenseNumber,
  syndicate_number: p.syndicateNumber,
  verification_status: p.verificationStatus,
  is_accepting_bookings: p.isAcceptingBookings,
  organization: null, // organizations: Phase 3
  rating_avg: p.ratingAvg,
  rating_count: p.ratingCount,
  completed_visits: p.completedVisitsCount,
});

/** GET /provider/profile (spec §7.10). */
export const presentProviderProfile = (p: IProviderProfile, checklist: OnboardingChecklist) => ({
  ...profileFields(p),
  onboarding: presentChecklist(checklist),
});

export const presentProviderDocument = (d: IProviderDocument, fileUrl: string) => ({
  id: String(d._id),
  type: d.type,
  status: d.status,
  mime: d.mime,
  file_url: fileUrl,
  expires_at: dateOnly(d.expiresAt),
  review_note: d.reviewNote,
  uploaded_at: d.createdAt.toISOString(),
});

export const presentVerificationStatus = (p: IProviderProfile, documents: IProviderDocument[]) => ({
  status: p.verificationStatus,
  rejection_reason: p.rejectionReason,
  admin_message: p.adminMessage,
  submitted_at: iso(p.submittedAt),
  reviewed_at: iso(p.reviewedAt),
  documents: documents.map((d) => ({
    id: String(d._id),
    type: d.type,
    status: d.status,
    review_note: d.reviewNote,
  })),
});

export const presentServiceAreas = (
  p: IProviderProfile,
  places: Map<string, AreaDescription>,
  lang: Language,
) =>
  p.serviceAreas.map((a) => {
    const place = places.get(String(a.areaId));
    return {
      area_id: String(a.areaId),
      name: place ? localized(place.area.nameAr, place.area.nameEn, lang) : '',
      governorate_name: place ? localized(place.governorate.nameAr, place.governorate.nameEn, lang) : '',
      travel_fee: a.travelFee,
      max_travel_fee: place?.area.maxTravelFee ?? null,
      is_bookable: place?.bookable ?? false,
    };
  });

export const presentProviderServices = (
  p: IProviderProfile,
  catalog: Map<string, { service: ICatalogService; available: boolean }>,
  lang: Language,
) =>
  p.services.flatMap((s) => {
    const entry = catalog.get(String(s.serviceId));
    if (!entry) return [];
    return [
      {
        service_id: String(s.serviceId),
        name: localized(entry.service.nameAr, entry.service.nameEn, lang),
        pricing_unit: entry.service.pricingUnit,
        price: s.price,
        is_active: s.isActive,
        min_price: entry.service.minPrice,
        max_price: entry.service.maxPrice,
        is_available: entry.available,
      },
    ];
  });

export const presentAvailability = (slots: IAvailabilitySlot[]) =>
  slots.map((s) => ({ day_of_week: s.dayOfWeek, start_time: s.startTime, end_time: s.endTime }));

export const presentTimeOff = (t: IProviderTimeOff) => ({
  id: String(t._id),
  starts_at: t.startsAt.toISOString(),
  ends_at: t.endsAt.toISOString(),
  reason: t.reason,
});

// ── Admin ──

export const presentQueueItem = (p: IProviderProfile, user: IUser, documentsCount: number) => ({
  id: String(p._id),
  type: 'provider' as const,
  name: user.fullName,
  phone: user.phone,
  provider_type: p.type,
  status: p.verificationStatus,
  submitted_at: iso(p.submittedAt),
  documents_count: documentsCount,
});

export const presentReviewDetail = (input: {
  profile: IProviderProfile;
  user: IUser;
  checklist: OnboardingChecklist;
  documents: Array<{ document: IProviderDocument; fileUrl: string }>;
  places: Map<string, AreaDescription>;
  catalog: Map<string, { service: ICatalogService; available: boolean }>;
  lang: Language;
}) => ({
  ...profileFields(input.profile),
  user: {
    id: String(input.user._id),
    full_name: input.user.fullName,
    phone: input.user.phone,
    gender: input.user.gender,
    date_of_birth: dateOnly(input.user.dateOfBirth),
  },
  submitted_at: iso(input.profile.submittedAt),
  rejection_reason: input.profile.rejectionReason,
  admin_message: input.profile.adminMessage,
  documents: input.documents.map(({ document, fileUrl }) => presentProviderDocument(document, fileUrl)),
  service_areas: presentServiceAreas(input.profile, input.places, input.lang),
  services: presentProviderServices(input.profile, input.catalog, input.lang),
  availability: presentAvailability(input.profile.availability),
  onboarding: presentChecklist(input.checklist),
});
