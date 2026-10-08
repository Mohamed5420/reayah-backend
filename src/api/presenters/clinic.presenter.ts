import type { IClinic, IProviderClinic } from '../../interfaces/IClinic';
import type { AreaDescription } from '../../services/location/location.service';
import type { Language } from '../../utils/i18n';
import { localized } from './localize';
import { presentAvailability } from './provider.presenter';

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

const place = (clinic: IClinic, places: Map<string, AreaDescription>, lang: Language) => {
  const p = places.get(String(clinic.areaId));
  return {
    governorate: p
      ? { id: p.governorate.id, name: localized(p.governorate.nameAr, p.governorate.nameEn, lang) }
      : null,
    area: p ? { id: p.area.id, name: localized(p.area.nameAr, p.area.nameEn, lang) } : null,
  };
};

const licence = (clinic: IClinic, fileUrl: string | null) =>
  clinic.licence
    ? {
        uploaded_at: clinic.licence.uploadedAt.toISOString(),
        expires_at: iso(clinic.licence.expiresAt)?.slice(0, 10) ?? null,
        file_url: fileUrl,
      }
    : null;

/** The doctor's own view of a clinic, with their schedule there. */
export const presentClinic = (
  input: { clinic: IClinic; link: IProviderClinic | null; licenceUrl?: string | null },
  places: Map<string, AreaDescription>,
  lang: Language,
) => {
  const c = input.clinic;
  return {
    id: String(c._id),
    name: c.name,
    ...place(c, places, lang),
    street: c.street,
    building: c.building,
    floor: c.floor,
    landmark: c.landmark,
    phone: c.phone,
    is_active: c.isActive,
    status: c.status,
    admin_message: c.adminMessage,
    licence: licence(c, input.licenceUrl ?? null),
    schedule: input.link
      ? {
          slot_minutes: input.link.slotMinutes,
          instant_confirm: input.link.instantConfirm,
          hours: presentAvailability(input.link.hours),
        }
      : null,
    created_at: c.createdAt.toISOString(),
  };
};

export const presentAdminClinic = (
  c: IClinic,
  places: Map<string, AreaDescription>,
  lang: Language,
  licenceUrl: string | null = null,
) => ({
  id: String(c._id),
  name: c.name,
  owner: {
    kind: c.organizationId ? ('organization' as const) : ('provider' as const),
    provider_profile_id: c.providerProfileId ? String(c.providerProfileId) : null,
    organization_id: c.organizationId ? String(c.organizationId) : null,
  },
  ...place(c, places, lang),
  street: c.street,
  building: c.building,
  floor: c.floor,
  landmark: c.landmark,
  phone: c.phone,
  is_active: c.isActive,
  status: c.status,
  admin_message: c.adminMessage,
  licence: licence(c, licenceUrl),
  submitted_at: iso(c.submittedAt),
  reviewed_at: iso(c.reviewedAt),
  created_at: c.createdAt.toISOString(),
});
