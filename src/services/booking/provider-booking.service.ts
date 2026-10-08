import { Container, Service } from 'typedi';
import { Types, type ClientSession, type HydratedDocument } from 'mongoose';
import { BookingModel } from '../../database/models/booking/booking.model';
import { BookingOfferModel } from '../../database/models/booking/booking-offer.model';
import { ProviderProfileModel } from '../../database/models/provider/provider-profile.model';
import { PatientProfileModel } from '../../database/models/patient/patient-profile.model';
import { UserModel } from '../../database/models/user/user.model';
import type { IProviderProfile } from '../../interfaces/IProfiles';
import {
  AssignmentMode,
  BookingActor,
  BookingStatus,
  OfferStatus,
  PaymentMethod,
  PaymentStatus,
  type IBooking,
} from '../../interfaces/IBooking';
import { addDays, cairoDate, cairoToUtc } from '../../utils/time/cairo';
import type { Pagination } from '../../utils/response/pagination';
import {
  AssignmentDeadlinePassedError,
  ConflictError,
  InvalidStatusTransitionError,
  NotFoundError,
  OfferTakenError,
} from '../../utils/types-errors';
import type { AuditContext } from '../audit/audit.service';
import { LedgerService } from '../ledger/ledger.service';
import { PatientProfileService } from '../patient/patient-profile.service';
import { patientFeeFor } from './patient-fees';
import { CommissionService } from '../payouts/commission.service';
import { auditNotesRead } from '../patient/medical-audit';
import { SettingsService } from '../settings/settings.service';
import { nextStatuses } from './booking-state';
import {
  assertProviderFree,
  lockProviderSchedule,
  runBookingTransaction,
  transitionBooking,
} from './booking-transaction';

type ProviderDoc = HydratedDocument<IProviderProfile>;

/** Spec §9 (decision 4): providers see a patient's medical data while the visit is active and 7 days after. */
export const MEDICAL_ACCESS_DAYS_AFTER_COMPLETION = 7;

/** Visits a provider is actually doing (vs. requests they haven't accepted). */
const ASSIGNED_STATUSES = [
  BookingStatus.ACCEPTED,
  BookingStatus.ON_THE_WAY,
  BookingStatus.IN_PROGRESS,
  BookingStatus.COMPLETED,
];

/** Provider side of bookings (spec §7.10 "Bookings"). Every action is checked against the state machine. */
@Service()
export class ProviderBookingService {
  private readonly patients = Container.get(PatientProfileService);
  private readonly ledger = Container.get(LedgerService);
  private readonly settings = Container.get(SettingsService);

  /** GET /provider/home: today's visits, waiting requests, open offers, today's earnings. */
  async home(profile: ProviderDoc) {
    const today = cairoDate();
    const from = cairoToUtc(today, '00:00');
    const to = cairoToUtc(addDays(today, 1), '00:00');
    const [todayVisits, pendingRequests, openOffers] = await Promise.all([
      BookingModel.find({
        providerProfileId: profile._id,
        status: { $in: ASSIGNED_STATUSES },
        scheduledStart: { $gte: from, $lt: to },
      })
        .sort({ scheduledStart: 1 })
        .lean(),
      BookingModel.find({ providerProfileId: profile._id, status: BookingStatus.PENDING })
        .sort({ scheduledStart: 1 })
        .lean(),
      BookingOfferModel.countDocuments({
        providerProfileId: profile._id,
        status: OfferStatus.OFFERED,
        expiresAt: { $gt: new Date() },
      }),
    ]);
    const todayEarnings = todayVisits
      .filter((b) => b.status === BookingStatus.COMPLETED)
      .reduce((sum, b) => sum + b.price.providerPayout, 0);
    return { todayVisits, pendingRequests, openOffers, todayEarnings };
  }

  async list(
    profile: ProviderDoc,
    filters: { status?: BookingStatus; date?: string },
    pagination: Pagination,
  ) {
    const query = {
      providerProfileId: profile._id,
      // Unpaid card / wallet bookings stay out of sight until paid.
      status:
        filters.status && filters.status !== BookingStatus.AWAITING_PAYMENT
          ? filters.status
          : { $ne: BookingStatus.AWAITING_PAYMENT },
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
    return { data, total };
  }

  /**
   * GET /provider/bookings/{id}. While pending the provider sees only area, service and time; the
   * patient, phone, full address and notes appear once accepted; the medical summary (audited read)
   * only during the access window.
   */
  async getDetail(profile: ProviderDoc, bookingId: string, context: AuditContext) {
    const booking = await this.getAssigned(profile, bookingId);
    const revealed = booking.status !== BookingStatus.PENDING;
    const [patientProfile, patientUser] = revealed
      ? await Promise.all([
          PatientProfileModel.findById(booking.patientProfileId).setOptions({ withDeleted: true }),
          UserModel.findById(booking.patientUserId).select('phone').setOptions({ withDeleted: true }).lean(),
        ])
      : [null, null];
    const medical = hasMedicalAccess(booking)
      ? await this.patients.medicalSummary(String(booking.patientProfileId), context)
      : null;
    if (revealed && booking.patientNotes) await auditNotesRead(context, booking);
    return {
      booking,
      patientProfile,
      patientPhone: patientUser?.phone ?? null,
      medical,
      allowedActions: allowedActions(booking),
    };
  }

  // ── Direct requests ──

  /** pending → accepted. Must be before the response deadline, and the provider must still be free. */
  async accept(profile: ProviderDoc, bookingId: string, userId: string) {
    const booking = await this.getAssigned(profile, bookingId);
    if (booking.status !== BookingStatus.PENDING || booking.assignmentMode !== AssignmentMode.DIRECT) {
      throw new InvalidStatusTransitionError();
    }
    if (booking.assignmentDeadline && booking.assignmentDeadline <= new Date()) {
      throw new AssignmentDeadlinePassedError();
    }
    await this.assertMayTakeCash(profile, booking);
    return runBookingTransaction(async (tx) => {
      await lockProviderSchedule(profile._id, tx.session);
      await assertProviderFree(
        profile._id,
        booking.scheduledStart,
        booking.scheduledEnd,
        tx.session,
        booking._id,
      );
      return transitionBooking(tx, booking, BookingStatus.ACCEPTED, BookingActor.PROVIDER, {
        changedBy: userId,
        where: { providerProfileId: profile._id, assignmentMode: AssignmentMode.DIRECT },
        set: { assignmentDeadline: null },
      });
    });
  }

  decline(profile: ProviderDoc, bookingId: string, userId: string, reasonCode: string) {
    return this.act(profile, bookingId, userId, BookingStatus.DECLINED, { note: reasonCode });
  }

  // ── Visit ──

  /** Manual "on my way" button — no location is collected (spec §1). Home visits only. */
  onTheWay(profile: ProviderDoc, bookingId: string, userId: string) {
    return this.act(profile, bookingId, userId, BookingStatus.ON_THE_WAY);
  }

  /** Start: records whether it began within `on_time_grace_minutes` of the booked time (spec §6.13). */
  async start(profile: ProviderDoc, bookingId: string, userId: string) {
    const booking = await this.getAssigned(profile, bookingId);
    const grace = await this.settings.get('on_time_grace_minutes');
    const startedAt = new Date();
    return this.act(profile, bookingId, userId, BookingStatus.IN_PROGRESS, {
      set: { startedAt, isOnTime: startedAt.getTime() <= booking.scheduledStart.getTime() + grace * 60_000 },
    });
  }

  /** Complete: counts the visit and records the cash commission in the provider's ledger. */
  complete(profile: ProviderDoc, bookingId: string, userId: string) {
    return this.act(profile, bookingId, userId, BookingStatus.COMPLETED, {
      set: { completedAt: new Date() },
      after: async (updated, session) => {
        await ProviderProfileModel.updateOne(
          { _id: profile._id },
          { $inc: { completedVisitsCount: 1 } },
          { session },
        );
        await this.ledger.recordCompletion(updated, session);
      },
    });
  }

  /** The patient wasn't there — only from the booked time on. */
  async noShow(profile: ProviderDoc, bookingId: string, userId: string) {
    const booking = await this.getAssigned(profile, bookingId);
    if (booking.scheduledStart > new Date()) throw new ConflictError('errors.no_show_too_early');
    // The patient is charged the travel fee (setting travel_fee_on_no_show); it goes to the provider.
    const patientFee = await patientFeeFor(booking, 'no_show');
    return this.act(profile, bookingId, userId, BookingStatus.NO_SHOW, { set: { patientFee } });
  }

  cancel(
    profile: ProviderDoc,
    bookingId: string,
    userId: string,
    reason: { code: string; text?: string | null },
  ) {
    return this.act(profile, bookingId, userId, BookingStatus.CANCELLED, {
      set: {
        cancellationReason: { code: reason.code, text: reason.text ?? null },
        cancelledBy: BookingActor.PROVIDER,
      },
      note: reason.code,
    });
  }

  /** Confirms the cash was received (idempotent). */
  async cashCollected(profile: ProviderDoc, bookingId: string) {
    const booking = await this.getAssigned(profile, bookingId);
    if (booking.paymentMethod !== PaymentMethod.CASH) throw new ConflictError('errors.cash_not_applicable');
    if (![BookingStatus.IN_PROGRESS, BookingStatus.COMPLETED].includes(booking.status)) {
      throw new InvalidStatusTransitionError();
    }
    return BookingModel.findByIdAndUpdate(
      booking._id,
      { paymentStatus: PaymentStatus.PAID },
      { new: true },
    ).lean();
  }

  // ── Broadcast offers (spec §6.6, §6.10) ──

  async listOffers(profile: ProviderDoc) {
    const offers = await BookingOfferModel.find({
      providerProfileId: profile._id,
      status: OfferStatus.OFFERED,
      expiresAt: { $gt: new Date() },
    })
      .sort({ expiresAt: 1 })
      .lean();
    const bookings = await BookingModel.find({ _id: { $in: offers.map((o) => o.bookingId) } }).lean();
    const byId = new Map(bookings.map((b) => [String(b._id), b]));
    return offers.flatMap((offer) => {
      const booking = byId.get(String(offer.bookingId));
      return booking ? [{ offer, booking }] : [];
    });
  }

  /**
   * First to accept wins. The booking is claimed with a conditional update (still pending, no provider)
   * inside a transaction that also serializes on this provider, so two providers can never both win and
   * the winner can't be double-booked. Everyone else's offer becomes `lost`.
   */
  async acceptOffer(profile: ProviderDoc, offerId: string, userId: string) {
    return runBookingTransaction(async (tx) => {
      const offer = Types.ObjectId.isValid(offerId)
        ? await BookingOfferModel.findOne({ _id: offerId, providerProfileId: profile._id }).session(
            tx.session,
          )
        : null;
      if (!offer) throw new NotFoundError('errors.offer_not_found');
      if (offer.status === OfferStatus.LOST) throw new OfferTakenError();
      if (offer.status !== OfferStatus.OFFERED || offer.expiresAt <= new Date()) {
        throw new ConflictError('errors.offer_expired');
      }

      const booking = await BookingModel.findById(offer.bookingId).session(tx.session).lean();
      if (!booking || booking.status !== BookingStatus.PENDING || booking.providerProfileId) {
        throw new OfferTakenError();
      }
      // A staff member's offer comes from their owner's "send to all suitable" (still a member, not suspended).
      if (offer.organizationId) {
        const member =
          String(booking.organizationId) === String(offer.organizationId) &&
          String(profile.organizationId) === String(offer.organizationId) &&
          !profile.staffSuspended;
        if (!member) throw new OfferTakenError();
      }
      await this.assertMayTakeCash(profile, booking);
      await lockProviderSchedule(profile._id, tx.session);
      await assertProviderFree(
        profile._id,
        booking.scheduledStart,
        booking.scheduledEnd,
        tx.session,
        booking._id,
      );

      let updated: HydratedDocument<IBooking>;
      try {
        updated = await transitionBooking(tx, booking, BookingStatus.ACCEPTED, BookingActor.PROVIDER, {
          changedBy: userId,
          where: { providerProfileId: null, assignmentMode: booking.assignmentMode },
          set: {
            providerProfileId: profile._id,
            // An independent taking a fallback offer: the booking is theirs alone.
            organizationId: offer.organizationId ?? null,
            assignmentDeadline: null,
            fallbackEndsAt: null,
          },
        });
      } catch (err) {
        if (err instanceof InvalidStatusTransitionError) throw new OfferTakenError();
        throw err;
      }

      const now = new Date();
      await BookingOfferModel.updateOne(
        { _id: offer._id },
        { status: OfferStatus.ACCEPTED, respondedAt: now },
        { session: tx.session },
      );
      const others = await BookingOfferModel.find({
        bookingId: booking._id,
        _id: { $ne: offer._id },
        status: OfferStatus.OFFERED,
      }).session(tx.session);
      await BookingOfferModel.updateMany(
        { _id: { $in: others.map((o) => o._id) } },
        { status: OfferStatus.LOST, respondedAt: now },
        { session: tx.session },
      );
      tx.publish({
        type: 'offer_taken',
        booking: updated.toObject(),
        providerProfileIds: others.map((o) => String(o.providerProfileId)),
      });
      return updated;
    });
  }

  async declineOffer(profile: ProviderDoc, offerId: string) {
    const offer = Types.ObjectId.isValid(offerId)
      ? await BookingOfferModel.findOneAndUpdate(
          { _id: offerId, providerProfileId: profile._id, status: OfferStatus.OFFERED },
          { status: OfferStatus.DECLINED, respondedAt: new Date() },
          { new: true },
        )
      : null;
    if (!offer) throw new NotFoundError('errors.offer_not_found');
  }

  // ── Helpers ──

  /** Over the commission limit, a provider can't take on a new cash booking until they pay down. */
  private async assertMayTakeCash(profile: ProviderDoc, booking: Pick<IBooking, 'paymentMethod' | 'price'>) {
    if (booking.paymentMethod !== PaymentMethod.CASH) return;
    // Staff: the organization owes the commission, so its limit applies.
    if (
      await Container.get(CommissionService).bookingOwnerOverLimit({
        organizationId: profile.organizationId,
        providerProfileId: profile._id,
      })
    ) {
      throw new ConflictError('errors.commission_limit_reached');
    }
  }

  /** A booking currently assigned to this provider; 404 otherwise (including other providers' bookings). */
  private async getAssigned(profile: ProviderDoc, bookingId: string) {
    const booking = Types.ObjectId.isValid(bookingId)
      ? await BookingModel.findOne({
          _id: bookingId,
          providerProfileId: profile._id,
          status: { $ne: BookingStatus.AWAITING_PAYMENT },
        }).lean()
      : null;
    if (!booking) throw new NotFoundError('errors.booking_not_found');
    return booking;
  }

  private async act(
    profile: ProviderDoc,
    bookingId: string,
    userId: string,
    to: BookingStatus,
    options: {
      set?: Record<string, unknown>;
      note?: string;
      after?: (updated: IBooking, session: ClientSession) => Promise<void>;
    } = {},
  ) {
    const booking = await this.getAssigned(profile, bookingId);
    return runBookingTransaction(async (tx) => {
      const updated = await transitionBooking(tx, booking, to, BookingActor.PROVIDER, {
        changedBy: userId,
        where: { providerProfileId: profile._id },
        set: options.set,
        note: options.note,
      });
      if (options.after) await options.after(updated.toObject(), tx.session);
      return updated;
    });
  }
}

/** Active visit, or completed within the last 7 days (decision 4). */
export const hasMedicalAccess = (booking: IBooking, now = new Date()) => {
  if ([BookingStatus.ACCEPTED, BookingStatus.ON_THE_WAY, BookingStatus.IN_PROGRESS].includes(booking.status))
    return true;
  return (
    booking.status === BookingStatus.COMPLETED &&
    !!booking.completedAt &&
    now.getTime() - booking.completedAt.getTime() <= MEDICAL_ACCESS_DAYS_AFTER_COMPLETION * 24 * 3600_000
  );
};

/** Buttons the provider app should show (spec `allowed_actions`). */
export const allowedActions = (booking: IBooking, now = new Date()) => {
  const map: Partial<Record<BookingStatus, string>> = {
    [BookingStatus.ACCEPTED]: 'accept',
    [BookingStatus.DECLINED]: 'decline',
    [BookingStatus.ON_THE_WAY]: 'on_the_way',
    [BookingStatus.IN_PROGRESS]: 'start',
    [BookingStatus.COMPLETED]: 'complete',
    [BookingStatus.NO_SHOW]: 'no_show',
    [BookingStatus.CANCELLED]: 'cancel',
  };
  const actions = nextStatuses(booking.status, BookingActor.PROVIDER, booking.type)
    .filter((to) => to !== BookingStatus.NO_SHOW || booking.scheduledStart <= now)
    .flatMap((to) => (map[to] ? [map[to]] : []));
  if (
    booking.paymentMethod === PaymentMethod.CASH &&
    booking.paymentStatus === PaymentStatus.UNPAID &&
    [BookingStatus.IN_PROGRESS, BookingStatus.COMPLETED].includes(booking.status)
  ) {
    actions.push('cash_collected');
  }
  return actions;
};
