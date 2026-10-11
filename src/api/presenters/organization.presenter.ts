import type { IUser } from '../../interfaces/IUser';
import type { ICatalogService } from '../../interfaces/ICatalog';
import type {
  IOrganization,
  IOrganizationDocument,
  IStaffInvite,
  OrganizationChecklist,
} from '../../interfaces/IOrganization';
import type { IProviderProfile } from '../../interfaces/IProfiles';
import { AssignmentMode, BookingStatus, type IBooking, type IBookingOffer } from '../../interfaces/IBooking';
import type { StaffEligibility } from '../../services/organization/org-booking.service';
import { VerificationStatus } from '../../interfaces/enums';
import type { AreaDescription } from '../../services/location/location.service';
import type { Language } from '../../utils/i18n';
import { presentAvailability, presentProviderServices, presentServiceAreas } from './provider.presenter';
import { localized } from './localize';

/** Maps organizations to the API shapes in organization.validation.ts. */

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export const presentOrgChecklist = (c: OrganizationChecklist) => ({
  info_completed: c.infoCompleted,
  documents_uploaded: c.documentsUploaded,
  areas_selected: c.areasSelected,
  services_set: c.servicesSet,
  can_submit: c.canSubmit,
});

export type InviteStats = { pending: number; accepted: number; notAccepted: number };

export const presentOrganization = (
  org: IOrganization,
  logoUrl: string | null,
  checklist: OrganizationChecklist,
  inviteStats: InviteStats = { pending: 0, accepted: 0, notAccepted: 0 },
  place: { governorate: { id: string; name: string }; area: { id: string; name: string } } | null = null,
) => ({
  id: String(org._id),
  name: org.name,
  type: org.type,
  commercial_register_no: org.commercialRegisterNo,
  tax_id: org.taxId,
  description: org.description,
  phone: org.phone,
  address_text: org.addressText,
  governorate: place?.governorate ?? null,
  area: place?.area ?? null,
  manager_name: org.managerName ?? null,
  email: org.email ?? null,
  paused: org.licencePausedAt
    ? { reason: 'activity_licence_expired' as const, since: org.licencePausedAt.toISOString() }
    : null,
  logo_url: logoUrl,
  verification_status: org.verificationStatus,
  rejection_reason: org.rejectionReason,
  admin_message: org.adminMessage,
  submitted_at: iso(org.submittedAt),
  reviewed_at: iso(org.reviewedAt),
  onboarding: presentOrgChecklist(checklist),
  invite_stats: {
    pending: inviteStats.pending,
    accepted: inviteStats.accepted,
    not_accepted: inviteStats.notAccepted,
  },
  created_at: org.createdAt.toISOString(),
  updated_at: org.updatedAt.toISOString(),
});

export const presentOrgDocument = (
  d: IOrganizationDocument,
  fileUrl: string,
  backFileUrl: string | null = null,
) => ({
  id: String(d._id),
  type: d.type,
  status: d.status,
  mime: d.mime,
  file_url: fileUrl,
  back_file_url: backFileUrl,
  back_mime: d.backMime ?? null,
  issuing_authority: d.issuingAuthority ?? null,
  expires_at: d.expiresAt ? d.expiresAt.toISOString().slice(0, 10) : null,
  review_note: d.reviewNote,
  uploaded_at: d.createdAt.toISOString(),
});

export const presentOrgServiceAreas = (
  org: IOrganization,
  places: Map<string, AreaDescription>,
  teamSizes: Map<string, number>,
  lang: Language,
) =>
  presentServiceAreas(org, places, lang).map((area, i) => ({
    ...area,
    is_active: org.serviceAreas[i].isActive,
    team_size: teamSizes.get(area.area_id) ?? 0,
  }));

export const presentOrgServices = (
  org: IOrganization,
  catalog: Map<string, { service: ICatalogService; available: boolean }>,
  lang: Language,
) => presentProviderServices(org, catalog, lang);

const presentOwner = (owner: IUser | null) =>
  owner ? { id: String(owner._id), full_name: owner.fullName, phone: owner.phone } : null;

export const presentOrgQueueItem = (row: {
  org: IOrganization;
  owner: IUser | null;
  documentsCount: number;
}) => ({
  id: String(row.org._id),
  type: 'organization' as const,
  name: row.org.name,
  phone: row.org.phone ?? row.owner?.phone ?? '',
  organization_type: row.org.type,
  status: row.org.verificationStatus,
  submitted_at: iso(row.org.submittedAt),
  documents_count: row.documentsCount,
});

export const presentOrgReviewDetail = (input: {
  org: IOrganization;
  owner: IUser | null;
  logoUrl: string | null;
  checklist: OrganizationChecklist;
  documents: Array<{ document: IOrganizationDocument; fileUrl: string; backFileUrl?: string | null }>;
  place?: { governorate: { id: string; name: string }; area: { id: string; name: string } } | null;
  places: Map<string, AreaDescription>;
  teamSizes: Map<string, number>;
  catalog: Map<string, { service: ICatalogService; available: boolean }>;
  lang: Language;
}) => {
  const {
    onboarding: _onboarding,
    invite_stats: _stats,
    ...base
  } = presentOrganization(input.org, input.logoUrl, input.checklist, undefined, input.place ?? null);
  return {
    ...base,
    kind: 'organization' as const,
    owner: presentOwner(input.owner),
    commission_rate: input.org.commissionRate,
    documents: input.documents.map(({ document, fileUrl, backFileUrl }) =>
      presentOrgDocument(document, fileUrl, backFileUrl ?? null),
    ),
    service_areas: presentOrgServiceAreas(input.org, input.places, input.teamSizes, input.lang),
    services: presentOrgServices(input.org, input.catalog, input.lang),
    onboarding: presentOrgChecklist(input.checklist),
  };
};

export const presentAdminOrgListItem = (row: { org: IOrganization; owner: IUser | null }) => ({
  id: String(row.org._id),
  name: row.org.name,
  type: row.org.type,
  verification_status: row.org.verificationStatus,
  owner: presentOwner(row.owner),
  commission_rate: row.org.commissionRate,
  service_areas_count: row.org.serviceAreas.length,
  services_count: row.org.services.length,
  created_at: row.org.createdAt.toISOString(),
});

// ── Staff (M3.2) ──

type StaffUser = Pick<IUser, '_id' | 'fullName' | 'phone' | 'gender' | 'isOnline'>;

const staffStatusOf = (p: IProviderProfile) =>
  p.staffSuspended
    ? 'suspended'
    : p.verificationStatus === VerificationStatus.APPROVED
      ? 'active'
      : 'pending_verification';

export const presentStaffMember = (p: IProviderProfile, user: StaffUser, avatarUrl: string | null) => ({
  id: String(p._id),
  user_id: String(user._id),
  full_name: user.fullName,
  phone: user.phone,
  gender: user.gender ?? null,
  avatar_url: avatarUrl,
  type: p.type,
  status: staffStatusOf(p),
  verification_status: p.verificationStatus,
  is_accepting_bookings: p.isAcceptingBookings,
  is_online: user.isOnline,
  rating_avg: p.ratingAvg,
  completed_visits: p.completedVisitsCount,
  service_area_ids: p.serviceAreas.map((a) => String(a.areaId)),
  service_ids: p.services.map((s) => String(s.serviceId)),
  suspension: p.staffSuspended
    ? {
        reason: p.staffSuspendedReason ?? null,
        ends_at: p.staffSuspendedUntil ? p.staffSuspendedUntil.toISOString() : null,
      }
    : null,
});

export const presentStaffDetail = (input: {
  profile: IProviderProfile;
  user: StaffUser;
  avatarUrl: string | null;
  places: Map<string, AreaDescription>;
  catalog: Map<string, { service: ICatalogService; available: boolean }>;
  performance: {
    completedVisits: number;
    completedLast30Days: number;
    ratingAvg: number;
    ratingCount: number;
    onTimeRate: number | null;
  };
  lang: Language;
}) => ({
  ...presentStaffMember(input.profile, input.user, input.avatarUrl),
  services: presentProviderServices(input.profile, input.catalog, input.lang),
  service_areas: presentServiceAreas(input.profile, input.places, input.lang),
  availability: presentAvailability(input.profile.availability),
  performance: {
    completed_visits: input.performance.completedVisits,
    completed_last_30_days: input.performance.completedLast30Days,
    rating_avg: input.performance.ratingAvg,
    rating_count: input.performance.ratingCount,
    on_time_rate: input.performance.onTimeRate,
  },
  joined_at: input.profile.createdAt.toISOString(),
});

export const presentStaffInvite = (i: IStaffInvite) => ({
  id: String(i._id),
  phone: i.phone,
  full_name: i.fullName,
  type: i.type,
  status: i.status,
  area_ids: (i.areaIds ?? []).map(String),
  service_ids: (i.serviceIds ?? []).map(String),
  expires_at: i.expiresAt.toISOString(),
  last_sent_at: i.lastSentAt ? i.lastSentAt.toISOString() : null,
  created_at: i.createdAt.toISOString(),
});

export const presentReceivedInvite = (row: { invite: IStaffInvite; organizationName: string }) => ({
  id: String(row.invite._id),
  organization_name: row.organizationName,
  type: row.invite.type,
  expires_at: row.invite.expiresAt.toISOString(),
});

// ── Organization bookings (M3.3) ──

/** Buttons the owner app should show. */
const orgBookingActions = (b: IBooking, offer: boolean) => {
  if (offer) return ['assign', 'decline'] as const;
  if (
    b.status === BookingStatus.PENDING &&
    b.assignmentMode === AssignmentMode.ORGANIZATION &&
    !b.providerProfileId
  ) {
    return ['assign', 'broadcast', 'decline'] as const;
  }
  if (b.status === BookingStatus.ACCEPTED) return ['reassign', 'cancel'] as const;
  if (b.status === BookingStatus.ON_THE_WAY) return ['cancel'] as const;
  return [] as const;
};

export const presentOrgBooking = (input: {
  booking: IBooking;
  offer: Pick<IBookingOffer, '_id' | 'expiresAt'> | null;
  staff: { id: string; name: string; phone: string | null } | null;
  patient: { name: string; phone: string | null } | null;
  lang: Language;
}) => {
  const b = input.booking;
  return {
    id: String(b._id),
    reference_code: b.referenceCode,
    status: b.status,
    type: b.type,
    clinic: b.clinicId && b.clinic ? { id: String(b.clinicId), name: b.clinic.name } : null,
    service: { id: String(b.serviceId), name: localized(b.service.nameAr, b.service.nameEn, input.lang) },
    quantity: b.quantity,
    area_name: b.address.areaNameAr,
    scheduled_start: b.scheduledStart.toISOString(),
    scheduled_end: b.scheduledEnd.toISOString(),
    preferred_gender: b.preferredGender,
    assignment_deadline: input.offer
      ? input.offer.expiresAt.toISOString()
      : b.assignmentDeadline
        ? b.assignmentDeadline.toISOString()
        : null,
    staff: input.staff,
    price: {
      total: b.price.total,
      travel_fee: b.price.travelFee,
      payout: b.price.providerPayout,
      currency: 'EGP' as const,
    },
    payment_method: b.paymentMethod,
    payment_status: b.paymentStatus,
    offer: input.offer
      ? { id: String(input.offer._id), expires_at: input.offer.expiresAt.toISOString() }
      : null,
    patient: input.patient,
    address: { area_name: b.address.areaNameAr, full_text: input.patient ? b.address.fullText : null },
    allowed_actions: [...orgBookingActions(b, Boolean(input.offer))],
  };
};

export const presentEligibleStaff = (row: StaffEligibility) => ({
  id: String(row.profileId),
  name: row.name,
  gender: row.gender,
  rating_avg: row.ratingAvg,
  available: row.available,
  reason: row.reason,
});
