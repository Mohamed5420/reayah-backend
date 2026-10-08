import type { IUser } from '../../interfaces/IUser';
import type { ICatalogService } from '../../interfaces/ICatalog';
import type {
  IOrganization,
  IOrganizationDocument,
  IStaffInvite,
  OrganizationChecklist,
} from '../../interfaces/IOrganization';
import type { IProviderProfile } from '../../interfaces/IProfiles';
import { VerificationStatus } from '../../interfaces/enums';
import type { AreaDescription } from '../../services/location/location.service';
import type { Language } from '../../utils/i18n';
import { presentAvailability, presentProviderServices, presentServiceAreas } from './provider.presenter';

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
) => ({
  id: String(org._id),
  name: org.name,
  type: org.type,
  commercial_register_no: org.commercialRegisterNo,
  tax_id: org.taxId,
  description: org.description,
  phone: org.phone,
  address_text: org.addressText,
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

export const presentOrgDocument = (d: IOrganizationDocument, fileUrl: string) => ({
  id: String(d._id),
  type: d.type,
  status: d.status,
  mime: d.mime,
  file_url: fileUrl,
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
  documents: Array<{ document: IOrganizationDocument; fileUrl: string }>;
  places: Map<string, AreaDescription>;
  teamSizes: Map<string, number>;
  catalog: Map<string, { service: ICatalogService; available: boolean }>;
  lang: Language;
}) => {
  const {
    onboarding: _onboarding,
    invite_stats: _stats,
    ...base
  } = presentOrganization(input.org, input.logoUrl, input.checklist);
  return {
    ...base,
    kind: 'organization' as const,
    owner: presentOwner(input.owner),
    commission_rate: input.org.commissionRate,
    documents: input.documents.map(({ document, fileUrl }) => presentOrgDocument(document, fileUrl)),
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
  expires_at: i.expiresAt.toISOString(),
  created_at: i.createdAt.toISOString(),
});

export const presentReceivedInvite = (row: { invite: IStaffInvite; organizationName: string }) => ({
  id: String(row.invite._id),
  organization_name: row.organizationName,
  type: row.invite.type,
  expires_at: row.invite.expiresAt.toISOString(),
});
