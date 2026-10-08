import { Container, Service } from 'typedi';
import { Types, type ClientSession } from 'mongoose';
import { BookingModel } from '../../database/models/booking/booking.model';
import { ClinicModel } from '../../database/models/clinic/clinic.model';
import { StaffInviteModel } from '../../database/models/organization/organization.models';
import { PatientProfileModel } from '../../database/models/patient/patient-profile.model';
import { ProviderProfileModel } from '../../database/models/provider/provider-profile.model';
import { UserModel } from '../../database/models/user/user.model';
import { UserRole, VerificationStatus } from '../../interfaces/enums';
import { BookingActor, BookingStatus, BookingType, type IBooking } from '../../interfaces/IBooking';
import { StaffInviteStatus, type IOrganization } from '../../interfaces/IOrganization';
import { env } from '../../config/env.config';
import { t } from '../../utils/i18n';
import { logger } from '../../utils/logger/winston';
import { isOverLimit } from '../../utils/rate-limit';
import { addDays, cairoDate, cairoToUtc } from '../../utils/time/cairo';
import {
  ConflictError,
  ForbiddenError,
  InvalidStatusTransitionError,
  NotFoundError,
  TooManyRequestsError,
} from '../../utils/types-errors';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { SmsService } from '../sms/sms.service';
import { TokenService } from '../auth/token.service';
import { SettingsService } from '../settings/settings.service';
import { runBookingTransaction, transitionBooking } from '../booking/booking-transaction';
import { verifyCheckIn } from '../booking/clinic-visit';
import { patientFeeFor } from '../booking/patient-fees';

const INVITE_DAYS = 7;
const INVITES_PER_DAY = 30;
const DAY_MS = 24 * 3600_000;

/**
 * Branch reception (clinic visits, C4; decision at approval). The owner invites a receptionist to one
 * branch (SMS with the organization's name and the app link only, like staff invites); the invited number
 * signs up with role \`reception\`. A receptionist sees only that branch's appointments for today — patient
 * name, time, doctor, status — and can check patients in with the visit code (which starts the visit) or
 * record a no-show. Never medical data, booking notes, visit reports, prices or money. Every action,
 * including viewing the list, is audited. Removing a receptionist ends their sessions at once.
 */
@Service()
export class ReceptionService {
  private readonly audit = Container.get(AuditService);
  private readonly settings = Container.get(SettingsService);

  // ── Owner ──

  async invite(
    org: Pick<IOrganization, '_id' | 'name' | 'verificationStatus'>,
    ownerId: string,
    branchId: string,
    input: { phone: string; fullName: string },
  ) {
    if (org.verificationStatus !== VerificationStatus.APPROVED)
      throw new ConflictError('errors.organization_not_approved');
    const branch = await this.branchOf(org._id, branchId);
    if (await UserModel.exists({ phone: input.phone }))
      throw new ConflictError('errors.reception_phone_taken');
    if (await isOverLimit(`staff-invite:${String(org._id)}`, INVITES_PER_DAY, 24 * 3600)) {
      throw new TooManyRequestsError();
    }
    await StaffInviteModel.updateMany(
      { organizationId: org._id, phone: input.phone, status: StaffInviteStatus.PENDING },
      { status: StaffInviteStatus.REVOKED, respondedAt: new Date() },
    );
    const invite = await StaffInviteModel.create({
      organizationId: org._id,
      phone: input.phone,
      fullName: input.fullName,
      type: null,
      kind: 'reception',
      clinicId: branch._id,
      invitedBy: ownerId,
      expiresAt: new Date(Date.now() + INVITE_DAYS * DAY_MS),
    });
    await Container.get(SmsService)
      // Nothing about the person: the organization's name and the app link only (as staff invites).
      .send(input.phone, t('sms.staff_invite', { organization: org.name, link: env.appDownloadUrl }))
      .catch((err: unknown) => logger.error(`Reception invite SMS ${String(invite._id)} failed`, err));
    return invite.toObject();
  }

  /** Receptionists and open invites of a branch. */
  async listForBranch(org: Pick<IOrganization, '_id'>, branchId: string) {
    const branch = await this.branchOf(org._id, branchId);
    const [members, invites] = await Promise.all([
      UserModel.find({ 'reception.clinicId': branch._id, role: UserRole.RECEPTION })
        .select('fullName phone status createdAt')
        .lean(),
      StaffInviteModel.find({
        clinicId: branch._id,
        kind: 'reception',
        status: StaffInviteStatus.PENDING,
        expiresAt: { $gt: new Date() },
      }).lean(),
    ]);
    return { members, invites };
  }

  /** Removes a receptionist from the branch: no more access, sessions end now. */
  async remove(org: Pick<IOrganization, '_id'>, branchId: string, userId: string, context: AuditContext) {
    const branch = await this.branchOf(org._id, branchId);
    const result = await UserModel.updateOne(
      { _id: userId, role: UserRole.RECEPTION, 'reception.clinicId': branch._id },
      { reception: null },
    );
    if (!result.matchedCount) throw new NotFoundError('errors.reception_not_found');
    await Container.get(TokenService).revokeAllForUser(userId);
    await this.audit.log(context, {
      action: 'reception.remove',
      entityType: 'user',
      entityId: userId,
      metadata: { clinicId: String(branch._id) },
    });
  }

  /** Inside the registration transaction: the new account becomes reception at the invite's branch. */
  async joinAtSignup(session: ClientSession, user: { _id: Types.ObjectId; phone: string }, inviteId: string) {
    const invite = Types.ObjectId.isValid(inviteId)
      ? await StaffInviteModel.findOneAndUpdate(
          {
            _id: inviteId,
            phone: user.phone,
            kind: 'reception',
            status: StaffInviteStatus.PENDING,
            expiresAt: { $gt: new Date() },
          },
          { status: StaffInviteStatus.ACCEPTED, respondedAt: new Date(), userId: user._id },
          { new: true, session },
        ).lean()
      : null;
    if (!invite?.clinicId) throw new NotFoundError('errors.invite_not_found');
    await UserModel.updateOne(
      { _id: user._id },
      { reception: { organizationId: invite.organizationId, clinicId: invite.clinicId } },
      { session },
    );
  }

  // ── Reception ──

  /** Today's appointments at the receptionist's branch (Cairo day). Audited as a view. */
  async today(userId: string, context: AuditContext) {
    const { clinicId } = await this.assignment(userId);
    const today = cairoDate();
    const bookings = await BookingModel.find({
      clinicId,
      type: BookingType.CLINIC_VISIT,
      scheduledStart: { $gte: cairoToUtc(today, '00:00'), $lt: cairoToUtc(addDays(today, 1), '00:00') },
      status: {
        $in: [
          BookingStatus.PENDING,
          BookingStatus.ACCEPTED,
          BookingStatus.IN_PROGRESS,
          BookingStatus.COMPLETED,
          BookingStatus.NO_SHOW,
        ],
      },
    })
      .sort({ scheduledStart: 1 })
      .select(
        'referenceCode patientProfileId providerProfileId service scheduledStart scheduledEnd status checkIn',
      )
      .lean();
    const [patients, doctors] = await Promise.all([
      PatientProfileModel.find({ _id: { $in: bookings.map((b) => b.patientProfileId) } })
        .setOptions({ withDeleted: true })
        .select('fullName')
        .lean(),
      ProviderProfileModel.find({
        _id: { $in: bookings.flatMap((b) => (b.providerProfileId ? [b.providerProfileId] : [])) },
      })
        .select('userId')
        .lean(),
    ]);
    const doctorUsers = await UserModel.find({ _id: { $in: doctors.map((d) => d.userId) } })
      .select('fullName')
      .lean();
    await this.audit.log(context, {
      action: 'reception.appointments_view',
      entityType: 'clinic',
      entityId: String(clinicId),
      metadata: { date: today, count: bookings.length },
    });
    return bookings.map((b) => {
      const doctor = doctors.find((d) => b.providerProfileId && d._id.equals(b.providerProfileId));
      return {
        booking: b,
        patientName: patients.find((p) => p._id.equals(b.patientProfileId))?.fullName ?? '',
        doctorName: doctor ? (doctorUsers.find((u) => u._id.equals(doctor.userId))?.fullName ?? '') : null,
      };
    });
  }

  /** Check-in with the patient's visit code (or without it, with a reason): starts the visit. Audited. */
  async checkIn(
    userId: string,
    bookingId: string,
    input: { visitCode?: string; withoutCodeReason?: string },
    context: AuditContext,
  ) {
    const booking = await this.bookingAtBranch(userId, bookingId);
    if (booking.status !== BookingStatus.ACCEPTED || !booking.providerProfileId)
      throw new InvalidStatusTransitionError();
    const grace = await this.settings.get('on_time_grace_minutes');
    const startedAt = new Date();
    const checkIn = await verifyCheckIn(booking, input, startedAt);
    await runBookingTransaction((tx) =>
      transitionBooking(tx, booking, BookingStatus.IN_PROGRESS, BookingActor.ORGANIZATION, {
        changedBy: userId,
        set: {
          startedAt,
          isOnTime: startedAt.getTime() <= booking.scheduledStart.getTime() + grace * 60_000,
          checkIn,
        },
        note: 'reception_check_in',
      }),
    );
    await this.audit.log(context, {
      action: 'reception.check_in',
      entityType: 'booking',
      entityId: bookingId,
      metadata: { method: checkIn.method, reason: checkIn.reason },
    });
  }

  /** The patient didn't come — from start + \`clinic_no_show_grace_minutes\`. Audited. */
  async noShow(userId: string, bookingId: string, context: AuditContext) {
    const booking = await this.bookingAtBranch(userId, bookingId);
    const grace = await this.settings.get('clinic_no_show_grace_minutes');
    if (booking.scheduledStart.getTime() + grace * 60_000 > Date.now()) {
      throw new ConflictError('errors.no_show_too_early');
    }
    const patientFee = await patientFeeFor(booking, 'no_show');
    await runBookingTransaction((tx) =>
      transitionBooking(tx, booking, BookingStatus.NO_SHOW, BookingActor.ORGANIZATION, {
        changedBy: userId,
        set: { patientFee },
        note: 'reception_no_show',
      }),
    );
    await this.audit.log(context, {
      action: 'reception.no_show',
      entityType: 'booking',
      entityId: bookingId,
      metadata: {},
    });
  }

  // ── Helpers ──

  private async branchOf(orgId: Types.ObjectId, branchId: string) {
    const branch = Types.ObjectId.isValid(branchId)
      ? await ClinicModel.findOne({ _id: branchId, organizationId: orgId }).lean()
      : null;
    if (!branch) throw new NotFoundError('errors.branch_not_found');
    return branch;
  }

  private async assignment(userId: string) {
    const user = await UserModel.findById(userId).select('reception').lean();
    if (!user?.reception) throw new ForbiddenError('errors.reception_not_assigned');
    return user.reception;
  }

  /** A clinic appointment at the receptionist's branch (404 otherwise — never another branch's). */
  private async bookingAtBranch(userId: string, bookingId: string): Promise<IBooking> {
    const { clinicId, organizationId } = await this.assignment(userId);
    const booking = Types.ObjectId.isValid(bookingId)
      ? await BookingModel.findOne({
          _id: bookingId,
          clinicId,
          organizationId,
          type: BookingType.CLINIC_VISIT,
        }).lean()
      : null;
    if (!booking) throw new NotFoundError('errors.booking_not_found');
    return booking;
  }
}
