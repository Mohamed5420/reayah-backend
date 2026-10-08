import { Container, Service } from 'typedi';
import { Types, type FilterQuery } from 'mongoose';
import { BookingModel } from '../../database/models/booking/booking.model';
import { bookingEvents } from '../../events/booking.events';
import { BookingOfferModel } from '../../database/models/booking/booking-offer.model';
import { PatientProfileModel } from '../../database/models/patient/patient-profile.model';
import { ProviderProfileModel } from '../../database/models/provider/provider-profile.model';
import { UserModel } from '../../database/models/user/user.model';
import { type Gender, VerificationStatus } from '../../interfaces/enums';
import {
  BookingType,
  AssignmentMode,
  BookingActor,
  BookingStatus,
  OfferStatus,
  PaymentMethod,
  PreferredGender,
  type IBooking,
} from '../../interfaces/IBooking';
import { LedgerOwnerType } from '../../interfaces/ILedger';
import { NotificationType } from '../../interfaces/INotification';
import type { IOrganization } from '../../interfaces/IOrganization';
import { logger } from '../../utils/logger/winston';
import type { Pagination } from '../../utils/response/pagination';
import { addDays, cairoToUtc } from '../../utils/time/cairo';
import {
  AssignmentDeadlinePassedError,
  ConflictError,
  InvalidStatusTransitionError,
  NotFoundError,
  OfferTakenError,
  SlotUnavailableError,
} from '../../utils/types-errors';
import { BookingDeadlineService } from '../booking/booking-deadline.service';
import {
  assertProviderFree,
  lockProviderSchedule,
  recordHistory,
  runBookingTransaction,
  transitionBooking,
} from '../booking/booking-transaction';
import { ChatService } from '../chat/chat.service';
import { NotificationService } from '../notification/notification.service';
import { bookingParams } from '../notification/booking-notifications';
import { CommissionService } from '../payouts/commission.service';
import { SettingsService } from '../settings/settings.service';
import { OrgDiscoveryService } from './org-discovery.service';
import { offeredEntry } from '../catalog/visit-types';
import { ClinicDiscoveryService } from '../discovery/clinic-discovery.service';

/** Statuses in which the organization's assigned staff member is doing (or did) the visit. */
const ASSIGNED_STATUSES = [
  BookingStatus.ACCEPTED,
  BookingStatus.ON_THE_WAY,
  BookingStatus.IN_PROGRESS,
  BookingStatus.COMPLETED,
  BookingStatus.NO_SHOW,
  BookingStatus.DISPUTED,
];
/** A staff member's bookings that go back to the queue when they're removed. */
const TAKEN_BACK = [BookingStatus.ACCEPTED, BookingStatus.ON_THE_WAY, BookingStatus.IN_PROGRESS];

export type StaffEligibility = {
  profileId: Types.ObjectId;
  name: string;
  gender: Gender | null;
  ratingAvg: number;
  available: boolean;
  /** Why not: suspended, not_accepting, area, service, gender, busy (first that applies). */
  reason: string | null;
};

/**
 * The owner's side of organization bookings (spec §6.6, §7.11 "Bookings"; M3.3). Bookings to an
 * organization wait in its queue until the owner assigns a staff member (decision: that accepts the
 * booking at once) or sends it to all suitable staff (first to accept wins), within
 * `org_assign_deadline_minutes`. After the deadline the request goes to other independents and
 * organizations (fallback). Owners see operational details only — never booking notes or medical data
 * (decision); the patient's name, phone and address once a staff member is assigned.
 */
@Service()
export class OrgBookingService {
  private readonly orgs = Container.get(OrgDiscoveryService);
  private readonly settings = Container.get(SettingsService);
  private readonly notifications = Container.get(NotificationService);

  async list(
    org: IOrganization,
    filters: { status?: BookingStatus; date?: string; staffId?: string },
    pagination: Pagination,
  ) {
    const query: FilterQuery<IBooking> = {
      organizationId: org._id,
      status:
        filters.status && filters.status !== BookingStatus.AWAITING_PAYMENT
          ? filters.status
          : { $ne: BookingStatus.AWAITING_PAYMENT },
      ...(filters.staffId && Types.ObjectId.isValid(filters.staffId)
        ? { providerProfileId: new Types.ObjectId(filters.staffId) }
        : {}),
      ...(filters.date
        ? {
            scheduledStart: {
              $gte: cairoToUtc(filters.date, '00:00'),
              $lt: cairoToUtc(addDays(filters.date, 1), '00:00'),
            },
          }
        : {}),
    };
    const [data, total] = await Promise.all([
      BookingModel.find(query)
        .sort({ scheduledStart: 1 })
        .skip(pagination.skip)
        .limit(pagination.perPage)
        .lean(),
      BookingModel.countDocuments(query),
    ]);
    return { data, total, staff: await this.staffNames(data) };
  }

  /** Other organizations' requests offered to this one after their deadline (take one by assigning). */
  async offers(org: IOrganization) {
    const offers = await BookingOfferModel.find({
      organizationId: org._id,
      providerProfileId: null,
      status: OfferStatus.OFFERED,
      expiresAt: { $gt: new Date() },
    })
      .sort({ expiresAt: 1 })
      .lean();
    const bookings = await BookingModel.find({
      _id: { $in: offers.map((o) => o.bookingId) },
      status: BookingStatus.PENDING,
      providerProfileId: null,
    }).lean();
    const byId = new Map(bookings.map((b) => [String(b._id), b]));
    return offers.flatMap((offer) => {
      const booking = byId.get(String(offer.bookingId));
      return booking ? [{ offer, booking }] : [];
    });
  }

  /** One of the organization's bookings, or a request offered to it. 404 otherwise. */
  async get(org: IOrganization, bookingId: string) {
    const booking = Types.ObjectId.isValid(bookingId) ? await BookingModel.findById(bookingId).lean() : null;
    if (
      booking &&
      String(booking.organizationId) === String(org._id) &&
      booking.status !== BookingStatus.AWAITING_PAYMENT
    ) {
      return { booking, offer: null };
    }
    const offer = booking
      ? await BookingOfferModel.findOne({
          bookingId: booking._id,
          organizationId: org._id,
          providerProfileId: null,
          status: OfferStatus.OFFERED,
          expiresAt: { $gt: new Date() },
        }).lean()
      : null;
    if (!booking || !offer) throw new NotFoundError('errors.booking_not_found');
    return { booking, offer };
  }

  /**
   * GET /org/bookings/{id}: operational details. The patient's name, phone and full address only once
   * a staff member is assigned; never booking notes, the medical profile or visit reports (decision).
   */
  async detail(org: IOrganization, bookingId: string) {
    const { booking, offer } = await this.get(org, bookingId);
    const revealed =
      !offer && Boolean(booking.providerProfileId) && ASSIGNED_STATUSES.includes(booking.status);
    const [patientProfile, patientUser, staff] = await Promise.all([
      revealed
        ? PatientProfileModel.findById(booking.patientProfileId)
            .select('fullName')
            .setOptions({ withDeleted: true })
            .lean()
        : null,
      revealed
        ? UserModel.findById(booking.patientUserId).select('phone').setOptions({ withDeleted: true }).lean()
        : null,
      this.staffNames([booking]),
    ]);
    return {
      booking,
      offer,
      patient: revealed ? { name: patientProfile?.fullName ?? '', phone: patientUser?.phone ?? null } : null,
      staff: booking.providerProfileId ? (staff.get(String(booking.providerProfileId)) ?? null) : null,
    };
  }

  /** GET /org/bookings/{id}/eligible-staff: every active member, available ones first. */
  async eligibleStaff(org: IOrganization, bookingId: string): Promise<StaffEligibility[]> {
    const { booking } = await this.get(org, bookingId);
    const members = await ProviderProfileModel.find({
      organizationId: org._id,
      verificationStatus: VerificationStatus.APPROVED,
    }).lean();
    const users = new Map(
      (
        await UserModel.find({ _id: { $in: members.map((m) => m.userId) } })
          .select('fullName gender')
          .lean()
      ).map((u) => [String(u._id), u]),
    );
    const clinic = booking.type === BookingType.CLINIC_VISIT;
    const atBranch = clinic
      ? new Set(
          (await Container.get(ClinicDiscoveryService).branchDoctors(org._id, booking.clinicId!)).map((d) =>
            String(d.profile._id),
          ),
        )
      : null;
    const free = new Set(
      clinic
        ? (await this.freeAtBranch(org, booking)).map((d) => String(d.profile._id))
        : (
            await this.orgs.freeAt(
              await this.orgs.eligibleStaff(org._id, {
                serviceId: String(booking.serviceId),
                areaId: String(booking.areaId),
              }),
              await this.orgs.serviceRowFor(booking),
              booking.scheduledStart,
              booking.quantity,
              String(booking._id),
            )
          ).map((s) => String(s.profile._id)),
    );
    const rows = members.map((m): StaffEligibility => {
      const user = users.get(String(m.userId));
      const gender = (user?.gender ?? null) as Gender | null;
      const reason = m.staffSuspended
        ? 'suspended'
        : !m.isAcceptingBookings
          ? 'not_accepting'
          : atBranch && !atBranch.has(String(m._id))
            ? 'branch'
            : !atBranch && !m.serviceAreas.some((a) => a.areaId.equals(booking.areaId))
              ? 'area'
              : !atBranch && !offeredEntry(m.services, String(booking.serviceId), booking.type)
                ? 'service'
                : booking.preferredGender !== PreferredGender.ANY &&
                    String(gender) !== booking.preferredGender
                  ? 'gender'
                  : !free.has(String(m._id))
                    ? 'busy'
                    : null;
      return {
        profileId: m._id,
        name: user?.fullName ?? '',
        gender,
        ratingAvg: m.ratingAvg,
        available: !reason,
        reason,
      };
    });
    return rows.sort((a, b) => Number(b.available) - Number(a.available) || b.ratingAvg - a.ratingAvg);
  }

  /**
   * POST /org/bookings/{id}/assign — the organization accepts with this staff member (decision): right
   * area, service, preferred gender and free then, else 409 SLOT_UNAVAILABLE. Works for the
   * organization's own queue (before its deadline) and for a request offered to it in fallback (first
   * to take it wins; the booking becomes this organization's at the quoted price).
   */
  async assign(org: IOrganization, ownerId: string, bookingId: string, staffId: string) {
    const { booking, offer } = await this.get(org, bookingId);
    if (booking.status !== BookingStatus.PENDING || booking.providerProfileId)
      throw new InvalidStatusTransitionError();
    if (!offer) {
      // Its own request already went to other providers after the deadline (spec: ASSIGNMENT_DEADLINE_PASSED).
      if (booking.assignmentMode === AssignmentMode.BROADCAST) throw new AssignmentDeadlinePassedError();
      if (booking.assignmentMode !== AssignmentMode.ORGANIZATION) throw new InvalidStatusTransitionError();
      if (booking.assignmentDeadline && booking.assignmentDeadline <= new Date()) {
        throw new AssignmentDeadlinePassedError();
      }
    }
    const staff = await this.assertCanTake(org, booking, staffId);
    if (
      booking.paymentMethod === PaymentMethod.CASH &&
      (await Container.get(CommissionService).overLimit(org._id, LedgerOwnerType.ORGANIZATION))
    ) {
      throw new ConflictError('errors.commission_limit_reached');
    }
    return runBookingTransaction(async (tx) => {
      await lockProviderSchedule(staff, tx.session);
      await assertProviderFree(staff, booking.scheduledStart, booking.scheduledEnd, tx.session, booking._id);
      let updated;
      try {
        updated = await transitionBooking(tx, booking, BookingStatus.ACCEPTED, BookingActor.ORGANIZATION, {
          changedBy: ownerId,
          where: { providerProfileId: null, assignmentMode: booking.assignmentMode },
          set: {
            providerProfileId: staff,
            organizationId: org._id,
            assignmentMode: AssignmentMode.ORGANIZATION,
            assignmentDeadline: null,
            fallbackEndsAt: null,
          },
          note: offer ? 'taken_from_fallback' : 'assigned',
        });
      } catch (err) {
        // Someone else took it first (fallback race).
        if (err instanceof InvalidStatusTransitionError && offer) throw new OfferTakenError();
        throw err;
      }
      const now = new Date();
      if (offer) {
        await BookingOfferModel.updateOne(
          { _id: offer._id },
          { status: OfferStatus.ACCEPTED, respondedAt: now },
          { session: tx.session },
        );
      }
      const others = await BookingOfferModel.find({
        bookingId: booking._id,
        status: OfferStatus.OFFERED,
      }).session(tx.session);
      await BookingOfferModel.updateMany(
        { _id: { $in: others.map((o) => o._id) } },
        { status: OfferStatus.LOST, respondedAt: now },
        { session: tx.session },
      );
      const lostProviders = others.flatMap((o) => (o.providerProfileId ? [String(o.providerProfileId)] : []));
      if (lostProviders.length)
        tx.publish({ type: 'offer_taken', booking: updated.toObject(), providerProfileIds: lostProviders });
      tx.publish({ type: 'assigned', booking: updated.toObject(), providerProfileId: String(staff) });
      return updated.toObject();
    });
  }

  /** POST /org/bookings/{id}/reassign — another staff member for an accepted booking. */
  async reassign(org: IOrganization, ownerId: string, bookingId: string, staffId: string) {
    const { booking, offer } = await this.get(org, bookingId);
    if (offer || booking.status !== BookingStatus.ACCEPTED || !booking.providerProfileId) {
      throw new InvalidStatusTransitionError();
    }
    if (booking.providerProfileId.equals(staffId)) throw new ConflictError('errors.staff_already_assigned');
    const previous = booking.providerProfileId;
    const staff = await this.assertCanTake(org, booking, staffId);
    const updated = await runBookingTransaction(async (tx) => {
      await lockProviderSchedule(staff, tx.session);
      await assertProviderFree(staff, booking.scheduledStart, booking.scheduledEnd, tx.session, booking._id);
      const changed = await BookingModel.findOneAndUpdate(
        {
          _id: booking._id,
          status: BookingStatus.ACCEPTED,
          providerProfileId: previous,
          organizationId: org._id,
        },
        { $set: { providerProfileId: staff, remindersSent: { day: null, hour: null } } },
        { new: true, lean: true, session: tx.session },
      );
      if (!changed) throw new InvalidStatusTransitionError();
      await recordHistory(
        tx,
        booking._id,
        booking.status,
        booking.status,
        BookingActor.ORGANIZATION,
        ownerId,
        'reassigned',
      );
      tx.publish({
        type: 'status_changed',
        booking: changed,
        from: booking.status,
        to: booking.status,
        actor: BookingActor.ORGANIZATION,
        reason: 'reassigned',
      });
      tx.publish({
        type: 'assigned',
        booking: changed,
        providerProfileId: String(staff),
        reason: 'reassigned',
      });
      return changed;
    });
    // The previous member's chat closes (the patient keeps it read-only); they're told it's no longer theirs.
    await Container.get(ChatService).closeForReassignment(booking._id, previous);
    await this.notifyUnassigned(booking, previous);
    return updated;
  }

  /** POST /org/bookings/{id}/broadcast — "send to all suitable": offers to every eligible free member. */
  async broadcast(org: IOrganization, bookingId: string) {
    const { booking, offer } = await this.get(org, bookingId);
    if (
      offer ||
      booking.status !== BookingStatus.PENDING ||
      booking.assignmentMode !== AssignmentMode.ORGANIZATION
    ) {
      throw new InvalidStatusTransitionError();
    }
    if (!booking.assignmentDeadline || booking.assignmentDeadline <= new Date())
      throw new AssignmentDeadlinePassedError();
    const free =
      booking.type === BookingType.CLINIC_VISIT
        ? await this.freeAtBranch(org, booking)
        : await this.freeHomeStaff(org, booking);
    if (!free.length) throw new ConflictError('errors.no_eligible_staff');
    return this.offerTo(org, booking, free);
  }

  private async freeHomeStaff(org: IOrganization, booking: IBooking) {
    const eligible = await this.orgs.eligibleStaff(org._id, {
      serviceId: String(booking.serviceId),
      areaId: String(booking.areaId),
      gender:
        booking.preferredGender === PreferredGender.ANY
          ? null
          : (booking.preferredGender as unknown as Gender),
    });
    return this.orgs.freeAt(
      eligible,
      await this.orgs.serviceRowFor(booking),
      booking.scheduledStart,
      booking.quantity,
      String(booking._id),
    );
  }

  private async offerTo(
    org: IOrganization,
    booking: IBooking,
    free: Array<{ profile: { _id: Types.ObjectId } }>,
  ) {
    const already = new Set(
      (await BookingOfferModel.find({ bookingId: booking._id }).select('providerProfileId').lean()).map((o) =>
        String(o.providerProfileId),
      ),
    );
    const fresh = free.filter((s) => !already.has(String(s.profile._id)));
    if (fresh.length) {
      await BookingOfferModel.insertMany(
        fresh.map((s) => ({
          bookingId: booking._id,
          providerProfileId: s.profile._id,
          organizationId: org._id,
          expiresAt: booking.assignmentDeadline,
        })),
      );
      bookingEvents.publish({
        type: 'new_request',
        booking,
        providerProfileIds: fresh.map((s) => String(s.profile._id)),
      });
    }
    return { offered: free.length };
  }

  /**
   * POST /org/bookings/{id}/decline — on behalf of the organization. Its own request goes straight to
   * the fallback (when the patient allowed it) or is declined; a request offered to it is just passed on.
   */
  async decline(org: IOrganization, ownerId: string, bookingId: string, reasonCode: string) {
    const { booking, offer } = await this.get(org, bookingId);
    if (offer) {
      await BookingOfferModel.updateOne(
        { _id: offer._id, status: OfferStatus.OFFERED },
        { status: OfferStatus.DECLINED, respondedAt: new Date() },
      );
      return { status: booking.status, passedOn: true };
    }
    if (booking.status !== BookingStatus.PENDING || booking.assignmentMode !== AssignmentMode.ORGANIZATION) {
      throw new InvalidStatusTransitionError();
    }
    const deadlines = Container.get(BookingDeadlineService);
    if (booking.allowFallback && (await deadlines.moveToFallback(booking))) {
      return { status: BookingStatus.PENDING, passedOn: true };
    }
    await runBookingTransaction(async (tx) => {
      await transitionBooking(tx, booking, BookingStatus.DECLINED, BookingActor.ORGANIZATION, {
        changedBy: ownerId,
        where: { organizationId: org._id, providerProfileId: null },
        note: reasonCode,
      });
      await BookingOfferModel.updateMany(
        { bookingId: booking._id, status: OfferStatus.OFFERED },
        { status: OfferStatus.EXPIRED },
        { session: tx.session },
      );
    });
    return { status: BookingStatus.DECLINED, passedOn: false };
  }

  /** POST /org/bookings/{id}/cancel — an assigned booking, before the visit starts (pending: decline). */
  async cancel(
    org: IOrganization,
    ownerId: string,
    bookingId: string,
    reason: { code: string; text?: string | null },
  ) {
    const { booking, offer } = await this.get(org, bookingId);
    if (offer || ![BookingStatus.ACCEPTED, BookingStatus.ON_THE_WAY].includes(booking.status)) {
      throw new InvalidStatusTransitionError();
    }
    return runBookingTransaction(async (tx) =>
      (
        await transitionBooking(tx, booking, BookingStatus.CANCELLED, BookingActor.ORGANIZATION, {
          changedBy: ownerId,
          where: { organizationId: org._id },
          set: {
            cancellationReason: { code: reason.code, text: reason.text ?? null },
            cancelledBy: BookingActor.ORGANIZATION,
          },
          note: reason.code,
        })
      ).toObject(),
    );
  }

  /**
   * Removing a staff member (decision): their active bookings are taken from them and go back to the
   * organization's unassigned queue with a fresh deadline (same deadline and fallback rules), and they
   * lose access to those bookings and their chats at once.
   */
  async takeBackFrom(orgId: Types.ObjectId, staffProfileId: Types.ObjectId, ownerId: string) {
    const minutes = await this.settings.get('org_assign_deadline_minutes');
    const bookings = await BookingModel.find({
      organizationId: orgId,
      providerProfileId: staffProfileId,
      status: { $in: TAKEN_BACK },
    }).lean();
    for (const booking of bookings) {
      try {
        await runBookingTransaction(async (tx) => {
          const updated = await transitionBooking(
            tx,
            booking,
            BookingStatus.PENDING,
            BookingActor.ORGANIZATION,
            {
              changedBy: ownerId,
              where: { providerProfileId: staffProfileId, organizationId: orgId },
              set: {
                providerProfileId: null,
                assignmentMode: AssignmentMode.ORGANIZATION,
                assignmentDeadline: new Date(Date.now() + minutes * 60_000),
                deadlineWarningAt: null,
                startedAt: null,
                isOnTime: null,
                remindersSent: { day: null, hour: null },
              },
              note: 'staff_removed',
              reason: 'staff_removed',
            },
          );
          tx.publish({
            type: 'org_request',
            booking: updated.toObject(),
            organizationIds: [String(orgId)],
            reason: 'returned',
          });
        });
        await Container.get(ChatService).closeForReassignment(booking._id, staffProfileId);
      } catch (err) {
        logger.error(`Could not take booking ${String(booking._id)} back from removed staff`, err);
        throw err;
      }
    }
    // Their open offers from this organization lapse too.
    await BookingOfferModel.updateMany(
      { providerProfileId: staffProfileId, organizationId: orgId, status: OfferStatus.OFFERED },
      { status: OfferStatus.EXPIRED },
    );
    return bookings.length;
  }

  // ── Helpers ──

  /** The member can take this booking: theirs, active, right area / service / gender, free then. */
  /** Clinic bookings (C4): doctors at the booking's branch free for exactly its appointment. */
  private async freeAtBranch(org: Pick<IOrganization, '_id'>, booking: IBooking) {
    const clinics = Container.get(ClinicDiscoveryService);
    const doctors = await clinics.branchDoctors(org._id, booking.clinicId!, {
      gender:
        booking.preferredGender === PreferredGender.ANY
          ? undefined
          : (booking.preferredGender as unknown as Gender),
    });
    return clinics.freeDoctorsAt(
      doctors,
      await this.orgs.serviceRowFor(booking),
      booking.scheduledStart,
      String(booking._id),
    );
  }

  private async assertCanTake(org: IOrganization, booking: IBooking, staffId: string) {
    if (booking.type === BookingType.CLINIC_VISIT) {
      const free = (await this.freeAtBranch(org, booking)).filter((d) => d.profile._id.equals(staffId));
      if (free.length) return free[0].profile._id;
      const member = Types.ObjectId.isValid(staffId)
        ? await ProviderProfileModel.exists({ _id: staffId, organizationId: org._id })
        : null;
      if (!member) throw new NotFoundError('errors.staff_not_found');
      throw new SlotUnavailableError();
    }
    const eligible = Types.ObjectId.isValid(staffId)
      ? (
          await this.orgs.eligibleStaff(org._id, {
            serviceId: String(booking.serviceId),
            areaId: String(booking.areaId),
            gender:
              booking.preferredGender === PreferredGender.ANY
                ? null
                : (booking.preferredGender as unknown as Gender),
          })
        ).filter((s) => s.profile._id.equals(staffId))
      : [];
    if (!eligible.length) {
      // Not this organization's member at all → 404; a member who can't take it → 409 (spec).
      const member = Types.ObjectId.isValid(staffId)
        ? await ProviderProfileModel.exists({ _id: staffId, organizationId: org._id })
        : null;
      if (!member) throw new NotFoundError('errors.staff_not_found');
      throw new SlotUnavailableError();
    }
    const free = await this.orgs.freeAt(
      eligible,
      await this.orgs.serviceRowFor(booking),
      booking.scheduledStart,
      booking.quantity,
      String(booking._id),
    );
    if (!free.length) throw new SlotUnavailableError();
    return eligible[0].profile._id;
  }

  private async staffNames(bookings: Array<Pick<IBooking, 'providerProfileId'>>) {
    const ids = bookings.flatMap((b) => (b.providerProfileId ? [b.providerProfileId] : []));
    const profiles = await ProviderProfileModel.find({ _id: { $in: ids } })
      .select('userId')
      .setOptions({ withDeleted: true })
      .lean();
    const users = new Map(
      (
        await UserModel.find({ _id: { $in: profiles.map((p) => p.userId) } })
          .select('fullName phone')
          .setOptions({ withDeleted: true })
          .lean()
      ).map((u) => [String(u._id), u]),
    );
    return new Map(
      profiles.map((p) => {
        const user = users.get(String(p.userId));
        return [String(p._id), { id: String(p._id), name: user?.fullName ?? '', phone: user?.phone ?? null }];
      }),
    );
  }

  private async notifyUnassigned(booking: IBooking, staffProfileId: Types.ObjectId) {
    const profile = await ProviderProfileModel.findById(staffProfileId).select('userId').lean();
    if (!profile) return;
    await this.notifications
      .notify([profile.userId], {
        type: NotificationType.BOOKING_STATUS,
        template: 'booking_unassigned',
        params: await bookingParams(booking),
        data: { booking_id: String(booking._id) },
      })
      .catch((err: unknown) => logger.error('Unassigned notice failed', err));
  }
}
