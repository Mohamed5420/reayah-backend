import { randomInt } from 'node:crypto';
import { Container, Service } from 'typedi';
import { Types } from 'mongoose';
import { BookingModel } from '../../database/models/booking/booking.model';
import { BookingOfferModel } from '../../database/models/booking/booking-offer.model';
import { BookingStatusHistoryModel } from '../../database/models/booking/booking-status-history.model';
import { ReviewModel, VisitReportModel } from '../../database/models/aftercare/aftercare.models';
import { chatOpen } from '../chat/chat-window';
import { ProviderProfileModel } from '../../database/models/provider/provider-profile.model';
import { UserModel } from '../../database/models/user/user.model';
import {
  ACTIVE_BOOKING_STATUSES,
  AssignmentMode,
  GATEWAY_PAYMENT_METHODS,
  BookingActor,
  BookingStatus,
  OfferStatus,
  PaymentMethod,
  PaymentStatus,
  PreferredGender,
  type IBooking,
} from '../../interfaces/IBooking';
import type { Pagination } from '../../utils/response/pagination';
import type { Language } from '../../utils/i18n';
import {
  CancellationNotAllowedError,
  ConflictError,
  InvalidStatusTransitionError,
  NotFoundError,
  ValidationError,
} from '../../utils/types-errors';
import { SettingsService } from '../settings/settings.service';
import { canTransition } from './booking-state';
import {
  assertProviderFree,
  lockProviderSchedule,
  recordHistory,
  runBookingTransaction,
  transitionBooking,
} from './booking-transaction';
import { QuoteService, type BookingDraft } from './quote.service';
import type { BookingEvent } from '../../events/booking.events';
import { PaymentService } from '../payments/payment.service';
import { patientFeeFor } from './patient-fees';
import { CommissionService } from '../payouts/commission.service';
import { ChatService } from '../chat/chat.service';
import { OrgDiscoveryService } from '../organization/org-discovery.service';
import type { Gender } from '../../interfaces/enums';
import { OrganizationModel } from '../../database/models/organization/organization.models';
import { CreditService } from '../marketing/credit.service';
import { PackageService } from '../marketing/package.service';
import { PromoService } from '../marketing/promo.service';
import { discountsOf } from './pricing';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I

/** Human-readable reference, e.g. RY-24A7K3 (spec §4.6). */
export const generateReferenceCode = () =>
  `RY-${Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('')}`;

const minutesFromNow = (minutes: number) => new Date(Date.now() + minutes * 60_000);

/** Who hears about a new request: the chosen provider, or the organization's owner. */
export const requestEventFor = (booking: IBooking, reason?: 'rescheduled'): BookingEvent =>
  booking.organizationId && !booking.providerProfileId
    ? { type: 'org_request', booking, organizationIds: [String(booking.organizationId)], reason }
    : { type: 'new_request', booking, providerProfileIds: [String(booking.providerProfileId)], reason };

/** Patient side of bookings (spec §7.8). */
@Service()
export class BookingService {
  private readonly quotes = Container.get(QuoteService);
  private readonly settings = Container.get(SettingsService);

  /**
   * POST /bookings: re-validates the quote's booking from scratch, then creates it in a transaction
   * that serializes on the provider (no double booking). The price is the one the quote guaranteed.
   */
  async create(
    userId: string,
    input: { quoteToken: string; paymentMethod: PaymentMethod; patientNotes?: string | null },
  ) {
    const draft = this.quotes.verifyToken(input.quoteToken, userId);
    // Fully covered (package / credit): nothing to pay or collect — its own method, so cash reports and
    // commission dues stay accurate. Whatever the client chose is ignored.
    const covered = draft.price.total === 0;
    const paymentMethod = covered ? PaymentMethod.COVERED : input.paymentMethod;
    if (paymentMethod === PaymentMethod.COVERED && !covered) {
      throw new ValidationError({ payment_method: ['validation.invalid_value'] });
    }
    // Card / wallet (M2.3): only with the card_payment flag on and a gateway configured. The patient then
    // pays through the checkout returned with the booking, within card_payment_window_minutes.
    if (
      GATEWAY_PAYMENT_METHODS.includes(paymentMethod) &&
      !(await Container.get(PaymentService).cardPaymentsEnabled())
    ) {
      throw new ValidationError({ payment_method: ['validation.payment_method_unavailable'] });
    }
    if (
      paymentMethod === PaymentMethod.CASH &&
      (await Container.get(CommissionService).bookingOwnerOverLimit({
        organizationId: draft.organizationId,
        providerProfileId: draft.providerId,
      }))
    ) {
      throw new ConflictError('errors.provider_cash_unavailable');
    }
    // Booking an organization (M3.3): it lands in the owner's queue, to assign within the deadline.
    const orgBooking = Boolean(draft.organizationId);
    const prepared = await this.quotes.prepare(userId, {
      ...draft,
      scheduledStart: new Date(draft.scheduledStart),
    });
    const address = await this.quotes.addressSnapshot(prepared.address);
    const start = new Date(draft.scheduledStart);
    const end = new Date(draft.scheduledEnd);
    const responseMinutes = await this.settings.get(
      orgBooking ? 'org_assign_deadline_minutes' : 'direct_request_response_minutes',
    );
    const awaitingPayment = GATEWAY_PAYMENT_METHODS.includes(paymentMethod);
    const discounts = discountsOf(draft.price);

    return runBookingTransaction(async (tx) => {
      // A provider's time is held from the request on; an organization's staff is picked later.
      if (draft.providerId) {
        await lockProviderSchedule(draft.providerId, tx.session);
        await assertProviderFree(draft.providerId, start, end, tx.session);
      }
      const [booking] = await BookingModel.create(
        [
          {
            referenceCode: generateReferenceCode(),
            patientUserId: userId,
            patientProfileId: draft.patientProfileId,
            addressId: draft.addressId,
            address,
            areaId: prepared.area.id,
            serviceId: draft.serviceId,
            service: {
              nameAr: prepared.service.nameAr,
              nameEn: prepared.service.nameEn,
              pricingUnit: prepared.service.pricingUnit,
              durationMinutes: (end.getTime() - start.getTime()) / 60_000,
            },
            providerProfileId: draft.providerId,
            organizationId: draft.organizationId ?? null,
            type: draft.type,
            scheduledStart: start,
            scheduledEnd: end,
            quantity: draft.quantity,
            preferredGender: draft.preferredGender,
            assignmentMode: orgBooking ? AssignmentMode.ORGANIZATION : AssignmentMode.DIRECT,
            // Card / wallet: held in awaiting_payment, invisible to the provider; the response clock starts once paid.
            status: awaitingPayment ? BookingStatus.AWAITING_PAYMENT : BookingStatus.PENDING,
            assignmentDeadline: awaitingPayment ? null : minutesFromNow(responseMinutes),
            allowFallback: draft.allowFallback,
            patientNotes: input.patientNotes ?? null,
            price: draft.price,
            paymentMethod,
            // Covered: nothing to pay, so it is paid in full from the start.
            ...(covered ? { paymentStatus: PaymentStatus.PAID } : {}),
            packageSubscriptionId: draft.packageSubscriptionId ?? null,
            promo:
              draft.promoCodeId && draft.promoCode
                ? { promoCodeId: draft.promoCodeId, code: draft.promoCode }
                : null,
          },
        ],
        { session: tx.session },
      );
      // Benefits are taken in the same transaction: a package visit, a promo use, credit.
      if (draft.packageSubscriptionId) {
        await Container.get(PackageService).reserve(tx.session, draft.packageSubscriptionId, start);
      }
      if (draft.promoCodeId) {
        await Container.get(PromoService).redeem(tx.session, booking, draft.promoCodeId, discounts.promo);
      }
      await Container.get(CreditService).use(booking.patientUserId, discounts.credit, booking, tx.session);
      await recordHistory(tx, booking._id, null, booking.status, BookingActor.PATIENT, userId, null);
      if (!awaitingPayment) tx.publish(requestEventFor(booking.toObject()));
      return booking;
    });
  }

  async list(
    userId: string,
    filters: { scope?: 'upcoming' | 'past'; status?: BookingStatus },
    pagination: Pagination,
  ) {
    const upcoming = filters.scope !== 'past';
    const query = {
      patientUserId: userId,
      ...(filters.status
        ? { status: filters.status }
        : { status: upcoming ? { $in: ACTIVE_BOOKING_STATUSES } : { $nin: ACTIVE_BOOKING_STATUSES } }),
    };
    const [data, total] = await Promise.all([
      BookingModel.find(query)
        .sort({ scheduledStart: upcoming ? 1 : -1 })
        .skip(pagination.skip)
        .limit(pagination.perPage)
        .lean(),
      BookingModel.countDocuments(query),
    ]);
    return {
      data,
      total,
      providers: await this.providerCards(data),
      organizations: await this.organizationNames(data),
    };
  }

  async getOwned(userId: string, bookingId: string) {
    const booking = Types.ObjectId.isValid(bookingId)
      ? await BookingModel.findOne({ _id: bookingId, patientUserId: userId }).lean()
      : null;
    if (!booking) throw new NotFoundError('errors.booking_not_found');
    return booking;
  }

  /** GET /bookings/{id}: the booking, its timeline and the provider. */
  async getDetail(userId: string, bookingId: string) {
    const booking = await this.getOwned(userId, bookingId);
    const [timeline, providers, reviewed, report, organizations] = await Promise.all([
      BookingStatusHistoryModel.find({ bookingId: booking._id }).sort({ createdAt: 1 }).lean(),
      this.providerCards([booking]),
      ReviewModel.exists({ bookingId: booking._id }),
      VisitReportModel.findOne({ bookingId: booking._id }).select('_id').lean(),
      this.organizationNames([booking]),
    ]);
    const freeWindowHours = await this.settings.get('cancellation_free_window_hours');
    return {
      booking,
      timeline,
      provider: booking.providerProfileId ? (providers.get(String(booking.providerProfileId)) ?? null) : null,
      organization: booking.organizationId
        ? (organizations.get(String(booking.organizationId)) ?? null)
        : null,
      flags: {
        canCancel: canTransition(booking.status, BookingStatus.CANCELLED, BookingActor.PATIENT, booking.type),
        canReschedule: canReschedule(booking, freeWindowHours),
        canReview: booking.status === BookingStatus.COMPLETED && !reviewed,
        canChat: chatOpen(booking),
      },
      visitReportId: report ? String(report._id) : null,
    };
  }

  /**
   * Patients can cancel until the visit starts, free — except after the provider marked "on the way",
   * when the booking's travel fee is charged (setting travel_fee_on_late_cancellation). A paid card /
   * wallet booking is refunded right after, minus that fee.
   */
  async cancel(userId: string, bookingId: string, reason: { code: string; text?: string | null }) {
    const booking = await this.getOwned(userId, bookingId);
    if (!canTransition(booking.status, BookingStatus.CANCELLED, BookingActor.PATIENT, booking.type)) {
      throw new InvalidStatusTransitionError();
    }
    const patientFee =
      booking.status === BookingStatus.ON_THE_WAY ? await patientFeeFor(booking, 'late_cancellation') : null;
    // Accepted, inside the free window, provider not on the way yet: free, but on the patient's record.
    const lateCancellation =
      booking.status === BookingStatus.ACCEPTED &&
      !withinFreeWindow(booking, await this.settings.get('cancellation_free_window_hours'));
    await runBookingTransaction(async (tx) => {
      await transitionBooking(tx, booking, BookingStatus.CANCELLED, BookingActor.PATIENT, {
        changedBy: userId,
        set: {
          cancellationReason: { code: reason.code, text: reason.text ?? null },
          cancelledBy: BookingActor.PATIENT,
          patientFee,
          lateCancellation,
        },
        note: reason.code,
      });
      await BookingOfferModel.updateMany(
        { bookingId: booking._id, status: OfferStatus.OFFERED },
        { status: OfferStatus.EXPIRED },
        { session: tx.session },
      );
    });
    const fee = patientFee?.amount ?? 0;
    return {
      status: BookingStatus.CANCELLED,
      cancellationFee: fee,
      refundAmount:
        booking.paymentStatus === PaymentStatus.PAID &&
        GATEWAY_PAYMENT_METHODS.includes(booking.paymentMethod)
          ? booking.price.total - fee
          : 0,
    };
  }

  /** New time with the same provider; the booking goes back to pending until they accept again. */
  async reschedule(userId: string, bookingId: string, scheduledStart: Date) {
    const booking = await this.getOwned(userId, bookingId);
    const freeWindowHours = await this.settings.get('cancellation_free_window_hours');
    if (booking.organizationId) {
      return this.rescheduleWithOrganization(userId, booking, scheduledStart, freeWindowHours);
    }
    if (
      !booking.providerProfileId ||
      ![BookingStatus.PENDING, BookingStatus.ACCEPTED].includes(booking.status)
    ) {
      throw new InvalidStatusTransitionError();
    }
    if (!canReschedule(booking, freeWindowHours)) throw new CancellationNotAllowedError();

    const { draft } = await this.quotes.prepare(
      userId,
      { ...this.inputFrom(booking), scheduledStart },
      String(booking._id),
    );
    const start = new Date(draft.scheduledStart);
    const end = new Date(draft.scheduledEnd);
    const set = {
      scheduledStart: start,
      scheduledEnd: end,
      assignmentMode: AssignmentMode.DIRECT,
      assignmentDeadline: minutesFromNow(await this.settings.get('direct_request_response_minutes')),
      // A new time means new reminders.
      remindersSent: { day: null, hour: null },
    };

    await runBookingTransaction(async (tx) => {
      await lockProviderSchedule(booking.providerProfileId!, tx.session);
      await assertProviderFree(booking.providerProfileId!, start, end, tx.session, booking._id);
      let updated: IBooking | null;
      if (booking.status === BookingStatus.ACCEPTED) {
        updated = (
          await transitionBooking(tx, booking, BookingStatus.PENDING, BookingActor.PATIENT, {
            changedBy: userId,
            set,
            note: 'rescheduled',
            reason: 'rescheduled',
          })
        ).toObject();
      } else {
        updated = await BookingModel.findOneAndUpdate(
          { _id: booking._id, status: BookingStatus.PENDING, providerProfileId: booking.providerProfileId },
          { $set: set },
          { new: true, session: tx.session, lean: true },
        );
        if (!updated) throw new InvalidStatusTransitionError();
        await recordHistory(
          tx,
          booking._id,
          booking.status,
          booking.status,
          BookingActor.PATIENT,
          userId,
          'rescheduled',
        );
        tx.publish({
          type: 'status_changed',
          booking: updated,
          from: booking.status,
          to: booking.status,
          actor: BookingActor.PATIENT,
          reason: 'rescheduled',
        });
      }
      tx.publish({
        type: 'new_request',
        booking: updated,
        providerProfileIds: [String(booking.providerProfileId)],
        reason: 'rescheduled',
      });
    });
    return this.getDetail(userId, bookingId);
  }

  /**
   * An organization's booking: the new time must suit one of its staff, and it goes back to the owner's
   * queue (whoever was assigned may not be free then) with a fresh assignment deadline.
   */
  private async rescheduleWithOrganization(
    userId: string,
    booking: IBooking,
    scheduledStart: Date,
    freeWindowHours: number,
  ) {
    if (![BookingStatus.PENDING, BookingStatus.ACCEPTED].includes(booking.status)) {
      throw new InvalidStatusTransitionError();
    }
    if (!canReschedule(booking, freeWindowHours)) throw new CancellationNotAllowedError();
    const { draft } = await this.quotes.prepare(
      userId,
      { ...this.inputFrom(booking), scheduledStart },
      String(booking._id),
    );
    const newStart = new Date(draft.scheduledStart);
    const newEnd = new Date(draft.scheduledEnd);

    // Decision: the assigned staff member keeps it when still eligible and free at the new time.
    if (
      booking.status === BookingStatus.ACCEPTED &&
      booking.providerProfileId &&
      (await this.staffStillFits(booking, newStart))
    ) {
      const staff = booking.providerProfileId;
      await runBookingTransaction(async (tx) => {
        await lockProviderSchedule(staff, tx.session);
        await assertProviderFree(staff, newStart, newEnd, tx.session, booking._id);
        const updated = await BookingModel.findOneAndUpdate(
          { _id: booking._id, status: BookingStatus.ACCEPTED, providerProfileId: staff },
          {
            $set: {
              scheduledStart: newStart,
              scheduledEnd: newEnd,
              remindersSent: { day: null, hour: null },
            },
          },
          { new: true, session: tx.session, lean: true },
        );
        if (!updated) throw new InvalidStatusTransitionError();
        await recordHistory(
          tx,
          booking._id,
          booking.status,
          booking.status,
          BookingActor.PATIENT,
          userId,
          'rescheduled',
        );
        tx.publish({
          type: 'status_changed',
          booking: updated,
          from: booking.status,
          to: booking.status,
          actor: BookingActor.PATIENT,
          reason: 'rescheduled',
        });
        tx.publish({
          type: 'assigned',
          booking: updated,
          providerProfileId: String(staff),
          reason: 'rescheduled',
        });
        tx.publish({
          type: 'org_request',
          booking: updated,
          organizationIds: [String(booking.organizationId)],
          reason: 'time_changed',
        });
      });
      return this.getDetail(userId, String(booking._id));
    }

    // Otherwise back to the owner's queue with a fresh deadline.
    const set = {
      scheduledStart: newStart,
      scheduledEnd: newEnd,
      providerProfileId: null,
      assignmentMode: AssignmentMode.ORGANIZATION,
      assignmentDeadline: minutesFromNow(await this.settings.get('org_assign_deadline_minutes')),
      deadlineWarningAt: null,
      remindersSent: { day: null, hour: null },
    };
    const previous = booking.providerProfileId;
    await runBookingTransaction(async (tx) => {
      let updated: IBooking | null;
      if (booking.status === BookingStatus.ACCEPTED) {
        updated = (
          await transitionBooking(tx, booking, BookingStatus.PENDING, BookingActor.PATIENT, {
            changedBy: userId,
            where: { organizationId: booking.organizationId },
            set,
            note: 'rescheduled',
            reason: 'rescheduled',
          })
        ).toObject();
      } else {
        updated = await BookingModel.findOneAndUpdate(
          {
            _id: booking._id,
            status: BookingStatus.PENDING,
            organizationId: booking.organizationId,
            providerProfileId: null,
            assignmentMode: AssignmentMode.ORGANIZATION,
          },
          { $set: set },
          { new: true, session: tx.session, lean: true },
        );
        if (!updated) throw new InvalidStatusTransitionError();
        await recordHistory(
          tx,
          booking._id,
          booking.status,
          booking.status,
          BookingActor.PATIENT,
          userId,
          'rescheduled',
        );
        tx.publish({
          type: 'status_changed',
          booking: updated,
          from: booking.status,
          to: booking.status,
          actor: BookingActor.PATIENT,
          reason: 'rescheduled',
        });
      }
      // Staff offers for the old time lapse.
      await BookingOfferModel.updateMany(
        { bookingId: booking._id, status: OfferStatus.OFFERED },
        { status: OfferStatus.EXPIRED },
        { session: tx.session },
      );
      tx.publish(requestEventFor(updated, 'rescheduled'));
    });
    if (previous) await Container.get(ChatService).closeForReassignment(booking._id, previous);
    return this.getDetail(userId, String(booking._id));
  }

  /** The assigned staff member could still take the booking at `start` (eligible, free). */
  private async staffStillFits(booking: IBooking, start: Date) {
    const orgs = Container.get(OrgDiscoveryService);
    const staff = (
      await orgs.eligibleStaff(booking.organizationId!, {
        serviceId: String(booking.serviceId),
        areaId: String(booking.areaId),
        gender:
          booking.preferredGender === PreferredGender.ANY
            ? null
            : (booking.preferredGender as unknown as Gender),
      })
    ).filter((s) => s.profile._id.equals(booking.providerProfileId!));
    const free = await orgs.freeAt(
      staff,
      await orgs.serviceRowFor(booking),
      start,
      booking.quantity,
      String(booking._id),
    );
    return free.length > 0;
  }

  /** POST /bookings/{id}/rebook: same service, provider, patient and address — a fresh quote for a new time. */
  async rebook(userId: string, bookingId: string, scheduledStart: Date, lang: Language) {
    const booking = await this.getOwned(userId, bookingId);
    if (!booking.providerProfileId && !booking.organizationId) {
      throw new ValidationError({ booking: ['validation.not_rebookable'] });
    }
    // A fresh booking: no package visit or promo carried over (the patient can add them to the quote).
    return this.quotes.quote(
      userId,
      { ...this.inputFrom(booking), packageSubscriptionId: null, scheduledStart },
      lang,
    );
  }

  /** The patient's next active booking, for the home screen. */
  nextUpcoming(userId: string) {
    return BookingModel.findOne({ patientUserId: userId, status: { $in: ACTIVE_BOOKING_STATUSES } })
      .sort({ scheduledStart: 1 })
      .lean();
  }

  /** The organization each booking was made with (an organization's staff member does the visit). */
  async organizationNames(bookings: Array<Pick<IBooking, 'organizationId'>>) {
    const ids = [...new Set(bookings.flatMap((b) => (b.organizationId ? [String(b.organizationId)] : [])))];
    if (!ids.length) return new Map<string, { id: string; name: string }>();
    const orgs = await OrganizationModel.find({ _id: { $in: ids } })
      .select('name')
      .setOptions({ withDeleted: true })
      .lean();
    return new Map(orgs.map((o) => [String(o._id), { id: String(o._id), name: o.name }]));
  }

  /** Name, avatar key, rating and phone for each booking's provider. */
  async providerCards(bookings: Array<Pick<IBooking, 'providerProfileId'>>) {
    const ids = [
      ...new Set(bookings.flatMap((b) => (b.providerProfileId ? [String(b.providerProfileId)] : []))),
    ];
    const profiles = await ProviderProfileModel.find({ _id: { $in: ids } })
      .select('userId ratingAvg type')
      .setOptions({ withDeleted: true })
      .lean();
    const users = await UserModel.find({ _id: { $in: profiles.map((p) => p.userId) } })
      .select('fullName phone avatarKey')
      .setOptions({ withDeleted: true })
      .lean();
    const userById = new Map(users.map((u) => [String(u._id), u]));
    return new Map(
      profiles.map((p) => {
        const user = userById.get(String(p.userId));
        return [
          String(p._id),
          {
            id: String(p._id),
            name: user?.fullName ?? '',
            phone: user?.phone ?? null,
            avatarKey: user?.avatarKey ?? null,
            ratingAvg: p.ratingAvg,
          },
        ];
      }),
    );
  }

  private inputFrom(booking: IBooking): Omit<BookingDraft, 'scheduledStart' | 'scheduledEnd' | 'price'> {
    return {
      serviceId: String(booking.serviceId),
      // An organization's booking is rebooked / rescheduled with the organization, not the staff member.
      providerId: booking.organizationId ? null : String(booking.providerProfileId),
      organizationId: booking.organizationId ? String(booking.organizationId) : null,
      patientProfileId: String(booking.patientProfileId),
      addressId: String(booking.addressId),
      type: booking.type,
      preferredGender: booking.preferredGender,
      allowFallback: booking.allowFallback,
      quantity: booking.quantity,
      promoCode: null,
      packageSubscriptionId: booking.packageSubscriptionId ? String(booking.packageSubscriptionId) : null,
    };
  }
}

/** True until `hours` before the visit starts. */
export const withinFreeWindow = (
  booking: Pick<IBooking, 'scheduledStart'>,
  hours: number,
  now = new Date(),
) => now.getTime() <= booking.scheduledStart.getTime() - hours * 3600_000;

const canReschedule = (booking: IBooking, freeWindowHours: number) =>
  Boolean(booking.providerProfileId || booking.organizationId) &&
  (booking.status === BookingStatus.PENDING ||
    (booking.status === BookingStatus.ACCEPTED && withinFreeWindow(booking, freeWindowHours)));
