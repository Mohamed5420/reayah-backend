import type { ProviderCard } from '../../services/discovery';
import type { ServiceRow } from '../../services/catalog';
import type { IProviderProfile } from '../../interfaces/IProfiles';
import type { IUser } from '../../interfaces/IUser';
import type { Slot } from '../../services/discovery';
import type { Language } from '../../utils/i18n';
import { localized } from './localize';
import { presentSpecialty } from '../../services/catalog/specialties';

/** Maps discovery results to the API shapes in discovery.validation.ts. */

export const presentProviderCard = (
  card: ProviderCard,
  service: ServiceRow,
  avatarUrl: string | null,
  lang: Language = 'ar',
) => ({
  id: String(card.profile._id),
  name: card.user.fullName,
  avatar_url: avatarUrl,
  type: card.profile.type!,
  gender: card.user.gender,
  is_verified: true as const,
  specialty: presentSpecialty(card.profile.specialty, lang),
  years_of_experience: card.profile.yearsOfExperience,
  rating_avg: card.profile.ratingAvg,
  rating_count: card.profile.ratingCount,
  completed_visits: card.profile.completedVisitsCount,
  price: card.price,
  travel_fee: card.travelFee ?? 0,
  currency: 'EGP' as const,
  pricing_unit: service.pricingUnit,
  organization: null, // organizations: Phase 3
  next_available: card.nextAvailable ? new Date(card.nextAvailable).toISOString() : null,
});

export const presentPublicProfile = (input: {
  profile: IProviderProfile;
  user: IUser;
  avatarUrl: string | null;
  areas: Array<{ id: string; nameAr: string; nameEn: string | null }>;
  services: Array<{ service: ServiceRow; price: number }>;
  recentReviews: Array<{ rating: number; comment: string | null; patient_name: string; date: string }>;
  lang: Language;
}) => ({
  id: String(input.profile._id),
  name: input.user.fullName,
  avatar_url: input.avatarUrl,
  type: input.profile.type!,
  gender: input.user.gender,
  specialty: presentSpecialty(input.profile.specialty, input.lang),
  bio: input.profile.bio,
  years_of_experience: input.profile.yearsOfExperience,
  is_verified: true as const,
  is_accepting_bookings: input.profile.isAcceptingBookings,
  rating_avg: input.profile.ratingAvg,
  rating_count: input.profile.ratingCount,
  completed_visits: input.profile.completedVisitsCount,
  languages: input.profile.languages,
  service_areas: input.areas.map((a) => ({ id: a.id, name: localized(a.nameAr, a.nameEn, input.lang) })),
  services: input.services.map(({ service, price }) => ({
    service_id: service.id,
    name: localized(service.nameAr, service.nameEn, input.lang),
    price,
    pricing_unit: service.pricingUnit,
  })),
  organization: null,
  recent_reviews: input.recentReviews,
});

export const presentSlots = (date: string, slots: Slot[]) => ({
  date,
  slots: slots.map((s) => ({
    start: s.start.toISOString(),
    end: s.end.toISOString(),
    available: s.available,
  })),
});
