import { Container, Service } from 'typedi';
import { Types } from 'mongoose';
import { ClinicModel } from '../../database/models/clinic/clinic.model';
import { ProviderProfileModel } from '../../database/models/provider/provider-profile.model';
import { UserModel } from '../../database/models/user/user.model';
import { ProviderType } from '../../interfaces/enums';
import type { IAvailabilitySlot } from '../../interfaces/IProfiles';
import type { IOrganization } from '../../interfaces/IOrganization';
import { ConflictError, NotFoundError } from '../../utils/types-errors';
import { ClinicService, type ClinicDoc, type ClinicInput } from './clinic.service';

/**
 * Organization branches (clinic visits, C4): an organization's clinics, in the same `clinics` collection
 * as doctors' own (`organizationId` set). Each branch is reviewed with its licence like any clinic. The
 * owner places staff doctors at branches with weekly hours there (`profile.clinics[]`, the same overlap
 * rules as a doctor's own clinics) — those are the doctors patients can book at the branch.
 */
@Service()
export class BranchService {
  private readonly clinics = Container.get(ClinicService);

  /** Branches with the doctors placed there. */
  async list(org: Pick<IOrganization, '_id'>) {
    const [branches, staff] = await Promise.all([
      ClinicModel.find({ organizationId: org._id }).sort({ createdAt: 1 }).lean(),
      ProviderProfileModel.find({ organizationId: org._id, 'clinics.0': { $exists: true } })
        .select('userId clinics')
        .lean(),
    ]);
    const names = new Map(
      (
        await UserModel.find({ _id: { $in: staff.map((s) => s.userId) } })
          .select('fullName')
          .lean()
      ).map((u) => [String(u._id), u.fullName]),
    );
    return branches.map((branch) => ({
      branch,
      doctors: staff.flatMap((s) => {
        const link = s.clinics.find((l) => l.clinicId.equals(branch._id));
        return link ? [{ profileId: s._id, name: names.get(String(s.userId)) ?? '', link }] : [];
      }),
    }));
  }

  async get(org: Pick<IOrganization, '_id'>, branchId: string) {
    const branch = Types.ObjectId.isValid(branchId)
      ? ((await ClinicModel.findOne({ _id: branchId, organizationId: org._id })) as ClinicDoc | null)
      : null;
    if (!branch) throw new NotFoundError('errors.branch_not_found');
    return branch;
  }

  async create(org: Pick<IOrganization, '_id'>, input: ClinicInput) {
    await this.clinics.assertBookableArea(input.governorateId, input.areaId);
    return (
      await ClinicModel.create({ ...this.clinics.toFields(input), organizationId: org._id })
    ).toObject();
  }

  async update(
    org: Pick<IOrganization, '_id'>,
    branchId: string,
    patch: Partial<ClinicInput> & { isActive?: boolean },
  ) {
    return this.clinics.updateDoc(await this.get(org, branchId), patch);
  }

  async attachLicence(
    userId: string,
    org: Pick<IOrganization, '_id'>,
    branchId: string,
    input: { fileKey: string; expiresAt?: Date | null },
  ) {
    return this.clinics.attachLicenceDoc(userId, await this.get(org, branchId), input);
  }

  async submit(org: Pick<IOrganization, '_id'>, branchId: string) {
    return this.clinics.submitDoc(await this.get(org, branchId));
  }

  /** Removes the branch and every doctor's hours there (active appointments: C4 booking guard). */
  async remove(org: Pick<IOrganization, '_id'>, branchId: string) {
    const branch = await this.get(org, branchId);
    await branch.softDelete();
    await ProviderProfileModel.updateMany(
      { organizationId: org._id },
      { $pull: { clinics: { clinicId: branch._id } } },
    );
  }

  /** Places a staff doctor at a branch with weekly hours there (replaces them). */
  async setDoctorSchedule(
    org: Pick<IOrganization, '_id'>,
    staffProfileId: string,
    branchId: string,
    input: { slotMinutes: number | null; hours: IAvailabilitySlot[] },
  ) {
    const branch = await this.get(org, branchId);
    const staff = Types.ObjectId.isValid(staffProfileId)
      ? await ProviderProfileModel.findOne({ _id: staffProfileId, organizationId: org._id })
      : null;
    if (!staff) throw new NotFoundError('errors.staff_not_found');
    if (staff.type !== ProviderType.DOCTOR) throw new ConflictError('errors.clinic_doctors_only');
    this.clinics.assertNoOverlap(staff, input.hours, { clinicId: branch._id, field: 'hours' });
    const hours = [...input.hours].sort(
      (a, b) => a.dayOfWeek - b.dayOfWeek || a.startTime.localeCompare(b.startTime),
    );
    const link = staff.clinics.find((l) => l.clinicId.equals(branch._id));
    if (link) {
      link.slotMinutes = input.slotMinutes;
      link.hours = hours;
    } else {
      // A specific doctor at a branch is confirmed at once (decision); "any doctor" goes to the owner.
      staff.clinics.push({
        clinicId: branch._id,
        slotMinutes: input.slotMinutes,
        instantConfirm: true,
        hours,
      });
    }
    await staff.save();
    return { branch: branch.toObject(), staff };
  }

  async removeDoctor(org: Pick<IOrganization, '_id'>, staffProfileId: string, branchId: string) {
    const branch = await this.get(org, branchId);
    const result = await ProviderProfileModel.updateOne(
      { _id: staffProfileId, organizationId: org._id },
      { $pull: { clinics: { clinicId: branch._id } } },
    );
    if (!result.matchedCount) throw new NotFoundError('errors.staff_not_found');
  }
}
