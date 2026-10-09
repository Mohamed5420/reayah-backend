import { Container, Service } from 'typedi';
import { Types, type HydratedDocument } from 'mongoose';
import { ClinicModel } from '../../database/models/clinic/clinic.model';
import { ProviderProfileModel } from '../../database/models/provider/provider-profile.model';
import { OrganizationModel } from '../../database/models/organization/organization.models';
import { ProviderType } from '../../interfaces/enums';
import {
  ClinicStatus,
  CLINIC_EDITABLE_STATUSES,
  type IClinic,
  type IProviderClinic,
} from '../../interfaces/IClinic';
import type { IAvailabilitySlot, IProviderProfile } from '../../interfaces/IProfiles';
import { NotificationType } from '../../interfaces/INotification';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  type ErrorFields,
} from '../../utils/types-errors';
import { LocationService } from '../location/location.service';
import { SettingsService } from '../settings/settings.service';
import { StorageService } from '../storage/storage.service';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { NotificationService } from '../notification/notification.service';
import type { Pagination } from '../../utils/response/pagination';
import { logger } from '../../utils/logger/winston';
import { t } from '../../utils/i18n';

type ProfileDoc = HydratedDocument<IProviderProfile>;
export type ClinicDoc = HydratedDocument<IClinic> & { softDelete: () => Promise<unknown> };

export type ClinicInput = {
  name: string;
  governorateId: string;
  areaId: string;
  street: string;
  building?: string | null;
  floor?: string | null;
  landmark?: string | null;
  phone: string;
};

/** Changing these on an approved clinic sends it back for review (the licence names a place). */
const ADDRESS_FIELDS: Array<keyof ClinicInput> = [
  'name',
  'governorateId',
  'areaId',
  'street',
  'building',
  'floor',
  'landmark',
];

const overlaps = (a: IAvailabilitySlot, b: IAvailabilitySlot) =>
  a.dayOfWeek === b.dayOfWeek && a.startTime < b.endTime && b.startTime < a.endTime;

/**
 * Clinics (clinic visits, C1). An independent doctor sets up to `max_clinics_per_doctor` clinics: a text
 * address and phone, a licence, weekly clinic hours, an appointment length and instant confirmation
 * (default on). Each clinic is reviewed by an admin (verifier) and is bookable only once approved; an
 * approved clinic whose name or address changes goes back to review. One person can't be in two places:
 * clinic hours never overlap home-visit hours or another clinic's (`assertNoOverlap`, also used when home
 * hours change). Organization branches use the same collection (C4).
 */
@Service()
export class ClinicService {
  private readonly locations = Container.get(LocationService);
  private readonly settings = Container.get(SettingsService);
  private readonly storage = Container.get(StorageService);
  private readonly audit = Container.get(AuditService);

  // ── Doctor side ──

  async listOwn(profile: ProfileDoc) {
    const clinics = await ClinicModel.find({ providerProfileId: profile._id }).sort({ createdAt: 1 }).lean();
    return clinics.map((clinic) => ({ clinic, link: this.linkOf(profile, clinic._id) }));
  }

  async getOwn(profile: ProfileDoc, clinicId: string) {
    const clinic = Types.ObjectId.isValid(clinicId)
      ? await ClinicModel.findOne({ _id: clinicId, providerProfileId: profile._id })
      : null;
    if (!clinic) throw new NotFoundError('errors.clinic_not_found');
    return clinic;
  }

  async create(profile: ProfileDoc, input: ClinicInput) {
    this.assertIndependentDoctor(profile);
    const max = await this.settings.get('max_clinics_per_doctor');
    if ((await ClinicModel.countDocuments({ providerProfileId: profile._id })) >= max) {
      throw new ConflictError('errors.clinic_limit_reached', { max });
    }
    await this.assertBookableArea(input.governorateId, input.areaId);
    const clinic = await ClinicModel.create({ ...this.toFields(input), providerProfileId: profile._id });
    profile.clinics.push({ clinicId: clinic._id, slotMinutes: null, instantConfirm: true, hours: [] });
    await profile.save();
    return { clinic: clinic.toObject(), link: this.linkOf(profile, clinic._id) };
  }

  async update(profile: ProfileDoc, clinicId: string, patch: Partial<ClinicInput> & { isActive?: boolean }) {
    const clinic = await this.updateDoc(await this.getOwn(profile, clinicId), patch);
    return { clinic, link: this.linkOf(profile, clinic._id) };
  }

  /** Shared by doctors' clinics and organizations' branches. */
  async updateDoc(clinic: ClinicDoc, patch: Partial<ClinicInput> & { isActive?: boolean }) {
    if (patch.areaId || patch.governorateId) {
      await this.assertBookableArea(
        patch.governorateId ?? String(clinic.governorateId),
        patch.areaId ?? String(clinic.areaId),
      );
    }
    const addressChanged = ADDRESS_FIELDS.some(
      (k) => patch[k] !== undefined && String(patch[k] ?? '') !== String(clinic.get(k) ?? ''),
    );
    clinic.set(this.toFields({ ...this.inputOf(clinic), ...patch }));
    if (patch.isActive !== undefined) clinic.isActive = patch.isActive;
    if (addressChanged && clinic.status === ClinicStatus.APPROVED) {
      clinic.status = ClinicStatus.PENDING;
      clinic.submittedAt = new Date();
    }
    await clinic.save();
    return clinic.toObject();
  }

  /** The licence: an upload with purpose `clinic_licence`, replacing any previous one. */
  async attachLicence(
    userId: string,
    profile: ProfileDoc,
    clinicId: string,
    input: { fileKey: string; expiresAt?: Date | null },
  ) {
    const clinic = await this.attachLicenceDoc(userId, await this.getOwn(profile, clinicId), input);
    return { clinic, link: this.linkOf(profile, clinic._id) };
  }

  async attachLicenceDoc(
    userId: string,
    clinic: ClinicDoc,
    input: { fileKey: string; expiresAt?: Date | null },
  ) {
    const fileKey = await this.storage.promote(input.fileKey, {
      ownerId: userId,
      purpose: 'clinic_licence',
      destPrefix: `clinics/${String(clinic._id)}`,
    });
    const previous = clinic.licence?.fileKey;
    clinic.licence = { fileKey, uploadedAt: new Date(), expiresAt: input.expiresAt ?? null };
    clinic.licenceNoticeAt = null;
    if (clinic.status === ClinicStatus.APPROVED) {
      clinic.status = ClinicStatus.PENDING;
      clinic.submittedAt = new Date();
    }
    await clinic.save();
    if (previous) await this.storage.delete(previous).catch(() => undefined);
    return clinic.toObject();
  }

  /** Sends a clinic for review: it needs a licence; from draft / changes requested / rejected. */
  async submit(profile: ProfileDoc, clinicId: string) {
    const clinic = await this.submitDoc(await this.getOwn(profile, clinicId));
    return { clinic, link: this.linkOf(profile, clinic._id) };
  }

  async submitDoc(clinic: ClinicDoc) {
    if (!CLINIC_EDITABLE_STATUSES.includes(clinic.status))
      throw new ConflictError('errors.clinic_not_submittable');
    if (!clinic.licence) throw new ConflictError('errors.clinic_licence_required');
    clinic.status = ClinicStatus.PENDING;
    clinic.submittedAt = new Date();
    await clinic.save();
    return clinic.toObject();
  }

  /** Soft-deletes the clinic and drops its hours from the profile (bookings guard: C3). */
  async remove(profile: ProfileDoc, clinicId: string) {
    const clinic = await this.getOwn(profile, clinicId);
    await clinic.softDelete();
    profile.clinics = profile.clinics.filter((l) => !l.clinicId.equals(clinic._id));
    await profile.save();
  }

  /** Appointment length, instant confirmation and weekly hours at one clinic (replaces the hours). */
  async setSchedule(
    profile: ProfileDoc,
    clinicId: string,
    input: { slotMinutes: number | null; instantConfirm: boolean; hours: IAvailabilitySlot[] },
  ) {
    const clinic = await this.getOwn(profile, clinicId);
    this.assertNoOverlap(profile, input.hours, { clinicId: clinic._id, field: 'hours' });
    const link = profile.clinics.find((l) => l.clinicId.equals(clinic._id));
    const sorted = sortSlots(input.hours);
    if (link) {
      link.slotMinutes = input.slotMinutes;
      link.instantConfirm = input.instantConfirm;
      link.hours = sorted;
    } else {
      profile.clinics.push({
        clinicId: clinic._id,
        slotMinutes: input.slotMinutes,
        instantConfirm: input.instantConfirm,
        hours: sorted,
      });
    }
    await profile.save();
    return { clinic: clinic.toObject(), link: this.linkOf(profile, clinic._id) };
  }

  /**
   * One person, one place at a time: `slots` (for one clinic, or the home-visit hours when `clinicId` is
   * null) must not overlap each other, the home-visit hours, or any other clinic's hours.
   */
  assertNoOverlap(
    profile: Pick<IProviderProfile, 'availability' | 'clinics'>,
    slots: IAvailabilitySlot[],
    target: { clinicId: Types.ObjectId | null; field: string },
  ) {
    const others: IAvailabilitySlot[] = [
      ...(target.clinicId ? profile.availability : []),
      ...(profile.clinics ?? [])
        .filter((l) => !target.clinicId || !l.clinicId.equals(target.clinicId))
        .flatMap((l) => l.hours),
    ];
    const fields: ErrorFields = {};
    for (const [i, slot] of slots.entries()) {
      if (slots.some((other, j) => j < i && overlaps(slot, other))) {
        (fields[`${target.field}.${i}`] ??= []).push('validation.slot_overlap');
      } else if (others.some((other) => overlaps(slot, other))) {
        (fields[`${target.field}.${i}`] ??= []).push('validation.overlaps_other_hours');
      }
    }
    if (Object.keys(fields).length) throw new ValidationError(fields);
  }

  /** Onboarding: a doctor who prices clinic visits needs a clinic with a licence and hours. */
  async hasUsableClinic(profile: Pick<IProviderProfile, '_id' | 'clinics'>) {
    const withHours = (profile.clinics ?? []).filter((l) => l.hours.length).map((l) => l.clinicId);
    if (!withHours.length) return false;
    return Boolean(
      await ClinicModel.exists({
        _id: { $in: withHours },
        providerProfileId: profile._id,
        licence: { $ne: null },
        status: { $ne: ClinicStatus.REJECTED },
      }),
    );
  }

  // ── Admin (verifier) ──

  async list(filter: { status?: ClinicStatus }, pagination: Pagination) {
    const query = filter.status ? { status: filter.status } : {};
    const [data, total] = await Promise.all([
      ClinicModel.find(query)
        .sort({ submittedAt: 1, createdAt: 1 })
        .skip(pagination.skip)
        .limit(pagination.perPage)
        .lean(),
      ClinicModel.countDocuments(query),
    ]);
    return { data, total };
  }

  async getForAdmin(clinicId: string) {
    const clinic = Types.ObjectId.isValid(clinicId) ? await ClinicModel.findById(clinicId).lean() : null;
    if (!clinic) throw new NotFoundError('errors.clinic_not_found');
    const owner = clinic.providerProfileId
      ? await ProviderProfileModel.findById(clinic.providerProfileId)
          .select('userId type specialty verificationStatus')
          .lean()
      : null;
    return {
      clinic,
      owner,
      licenceUrl: clinic.licence ? await this.storage.signedUrl(clinic.licence.fileKey) : null,
    };
  }

  /** approve / request changes / reject — pending clinics only; audited; the owner is told. */
  async decide(
    clinicId: string,
    decision: 'approve' | 'request_changes' | 'reject',
    message: string | null,
    context: AuditContext,
  ) {
    const next = {
      approve: ClinicStatus.APPROVED,
      request_changes: ClinicStatus.CHANGES_REQUESTED,
      reject: ClinicStatus.REJECTED,
    }[decision];
    const clinic = await ClinicModel.findOneAndUpdate(
      { _id: clinicId, status: ClinicStatus.PENDING },
      {
        status: next,
        adminMessage: decision === 'approve' ? null : message,
        reviewedAt: new Date(),
        reviewedBy: context.actorId ? new Types.ObjectId(context.actorId) : null,
      },
      { new: true },
    ).lean();
    if (!clinic) {
      if (await ClinicModel.exists({ _id: clinicId })) throw new ConflictError('errors.clinic_not_pending');
      throw new NotFoundError('errors.clinic_not_found');
    }
    await this.audit.log(context, {
      action: `clinic.${decision}`,
      entityType: 'clinic',
      entityId: String(clinic._id),
      metadata: { status: next },
    });
    await this.notifyOwner(clinic, next, message);
    return clinic;
  }

  /**
   * Daily (with providers' documents, 06:00 Cairo): licences expiring within `warnDays` → the owner is
   * told once; expired licences of approved clinics → the clinic goes back to "changes requested" (not
   * bookable) until a new licence is attached and approved. Audited.
   */
  async processLicenceExpiry(now: Date, warnDays: number) {
    const horizon = new Date(now.getTime() + warnDays * 24 * 3600_000);
    let warned = 0;
    let paused = 0;
    const expiring = await ClinicModel.find({
      'licence.expiresAt': { $gt: now, $lte: horizon },
      licenceNoticeAt: null,
    }).lean();
    for (const clinic of expiring) {
      const claimed = await ClinicModel.updateOne(
        { _id: clinic._id, licenceNoticeAt: null },
        { licenceNoticeAt: now },
      );
      if (!claimed.modifiedCount) continue;
      await this.notifyAbout(clinic, 'clinic_licence_expiring', {
        clinic: clinic.name,
        date: clinic.licence!.expiresAt!.toISOString().slice(0, 10),
      });
      warned++;
    }
    const expired = await ClinicModel.find({
      status: ClinicStatus.APPROVED,
      'licence.expiresAt': { $lte: now },
    }).lean();
    for (const clinic of expired) {
      const updated = await ClinicModel.updateOne(
        { _id: clinic._id, status: ClinicStatus.APPROVED },
        { status: ClinicStatus.CHANGES_REQUESTED, adminMessage: t('errors.clinic_licence_expired') },
      );
      if (!updated.modifiedCount) continue;
      paused++;
      await this.audit.log(
        { actorId: null },
        { action: 'clinic.paused_licence_expired', entityType: 'clinic', entityId: String(clinic._id) },
      );
      await this.notifyAbout(clinic, 'clinic_licence_expired', { clinic: clinic.name });
    }
    return { warned, paused };
  }

  // ── Helpers ──

  private assertIndependentDoctor(profile: IProviderProfile) {
    if (profile.organizationId) throw new ForbiddenError('errors.clinic_independents_only');
    if (profile.type !== ProviderType.DOCTOR) throw new ForbiddenError('errors.clinic_doctors_only');
  }

  async assertBookableArea(governorateId: string, areaId: string) {
    const area = await this.locations.findBookableArea(areaId);
    if (!area) throw new ValidationError({ area_id: ['validation.area_unavailable'] });
    if (area.governorateId !== governorateId) {
      throw new ValidationError({ governorate_id: ['validation.area_governorate_mismatch'] });
    }
  }

  toFields(input: ClinicInput) {
    return {
      name: input.name,
      governorateId: new Types.ObjectId(input.governorateId),
      areaId: new Types.ObjectId(input.areaId),
      street: input.street,
      building: input.building ?? null,
      floor: input.floor ?? null,
      landmark: input.landmark ?? null,
      phone: input.phone,
    };
  }

  private inputOf(clinic: IClinic): ClinicInput {
    return {
      name: clinic.name,
      governorateId: String(clinic.governorateId),
      areaId: String(clinic.areaId),
      street: clinic.street,
      building: clinic.building,
      floor: clinic.floor,
      landmark: clinic.landmark,
      phone: clinic.phone,
    };
  }

  private linkOf(
    profile: Pick<IProviderProfile, 'clinics'>,
    clinicId: Types.ObjectId,
  ): IProviderClinic | null {
    return profile.clinics.find((l) => l.clinicId.equals(clinicId)) ?? null;
  }

  /** The doctor (own clinic) or the organization's owner (branch). */
  private async ownerUserId(clinic: IClinic) {
    return clinic.providerProfileId
      ? (await ProviderProfileModel.findById(clinic.providerProfileId).select('userId').lean())?.userId
      : (await OrganizationModel.findById(clinic.organizationId).select('ownerUserId').lean())?.ownerUserId;
  }

  private async notifyAbout(
    clinic: IClinic,
    template: 'clinic_licence_expiring' | 'clinic_licence_expired',
    params: Record<string, string>,
  ) {
    const userId = await this.ownerUserId(clinic);
    if (!userId) return;
    await Container.get(NotificationService)
      .notify([userId], {
        type: NotificationType.VERIFICATION_RESULT,
        template,
        params,
        data: { clinic_id: String(clinic._id) },
      })
      .catch((err: unknown) =>
        logger.error(`Clinic notice ${template} failed for ${String(clinic._id)}`, err),
      );
  }

  private async notifyOwner(clinic: IClinic, status: ClinicStatus, message: string | null) {
    // A doctor's clinic → the doctor; a branch → the organization's owner.
    const userId = clinic.providerProfileId
      ? (await ProviderProfileModel.findById(clinic.providerProfileId).select('userId').lean())?.userId
      : (await OrganizationModel.findById(clinic.organizationId).select('ownerUserId').lean())?.ownerUserId;
    if (!userId) return;
    const profile = { userId };
    const template =
      status === ClinicStatus.APPROVED
        ? 'clinic_approved'
        : status === ClinicStatus.CHANGES_REQUESTED
          ? 'clinic_changes_requested'
          : 'clinic_rejected';
    await Container.get(NotificationService)
      .notify([profile.userId], {
        type: NotificationType.VERIFICATION_RESULT,
        template,
        params: { clinic: clinic.name, message: message ?? '' },
        data: { clinic_id: String(clinic._id), status },
      })
      .catch((err: unknown) => logger.error(`Clinic notice failed for ${String(clinic._id)}`, err));
  }
}

const sortSlots = (slots: IAvailabilitySlot[]) =>
  [...slots].sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.startTime.localeCompare(b.startTime));
