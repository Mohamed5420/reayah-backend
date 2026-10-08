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
import { PaymentService } from '../payments/payment.service';
import { patientFeeFor } from './patient-fees';
import { CommissionService } from '../payouts/commission.service';
import { CreditService } from '../marketing/credit.service';
import { PackageService } from '../marketing/package.service';
import { PromoService } from '../marketing/promo.service';
import { discountsOf } from './pricing';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I

/** Human-readable reference, e.g. RY-24A7K3 (spec §4.6). */
export const generateReferenceCode = () =>
  `RY-${Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('')}`;

const minutesFromNow = (minutes: number) => new Date(Date.now() + minutes * 60_000);

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
      (await Container.get(CommissionService).overLimit(draft.providerId))
    ) {
      throw new ConflictError('errors.provider_cash_unavailable');
    }
    const prepared = await this.quotes.prepare(userId, {
      ...draft,
      scheduledStart: new Date(draft.scheduledStart),
    });
    const address = await this.quotes.addressSnapshot(prepared.address);
    const start = new Date(draft.scheduledStart);
    const end = new Date(draft.scheduledEnd);
    const responseMinutes = await this.settings.get('direct_request_response_minutes');
    const awaitingPayment = GATEWAY_PAYMENT_METHODS.includes(paymentMethod);
    const discounts = discountsOf(draft.price);

    return runBookingTransaction(async (tx) => {
      await lockProviderSchedule(draft.providerId, tx.session);
      await assertProviderFree(draft.providerId, start, end, tx.session);
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
            type: draft.type,
            scheduledStart: start,
            scheduledEnd: end,
            quantity: draft.quantity,
            preferredGender: draft.preferredGender,
            assignmentMode: AssignmentMode.DIRECT,
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
      if (!awaitingPayment) {
        tx.publish({
          type: 'new_request',
          booking: booking.toObject(),
          providerProfileIds: [draft.providerId],
        });
      }
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
    return { data, total, providers: await this.providerCards(data) };
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
    const [timeline, providers, reviewed, report] = await Promise.all([
      BookingStatusHistoryModel.find({ bookingId: booking._id }).sort({ createdAt: 1 }).lean(),
      this.providerCards([booking]),
      ReviewModel.exists({ bookingId: booking._id }),
      VisitReportModel.findOne({ bookingId: booking._id }).select('_id').lean(),
    ]);
    const freeWindowHours = await this.settings.get('cancellation_free_window_hours');
    return {
      booking,
      timeline,
      provider: booking.providerProfileId ? (providers.get(String(booking.providerProfileId)) ?? null) : null,
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

  /** POST /bookings/{id}/rebook: same service, provider, patient and address — a fresh quote for a new time. */
  async rebook(userId: string, bookingId: string, scheduledStart: Date, lang: Language) {
    const booking = await this.getOwned(userId, bookingId);
    if (!booking.providerProfileId) throw new ValidationError({ booking: ['validation.not_rebookable'] });
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
      providerId: String(booking.providerProfileId),
      organizationId: null,
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
  Boolean(booking.providerProfileId) &&
  (booking.status === BookingStatus.PENDING ||
    (booking.status === BookingStatus.ACCEPTED && withinFreeWindow(booking, freeWindowHours)));
