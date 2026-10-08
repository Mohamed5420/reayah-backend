import { Container, Service } from 'typedi';
import { Types } from 'mongoose';
import { env } from '../../config/env.config';
import { BookingModel } from '../../database/models/booking/booking.model';
import { PaymentModel, RefundModel } from '../../database/models/payment/payment.models';
import { UserModel } from '../../database/models/user/user.model';
import {
  ACTIVE_BOOKING_STATUSES,
  BookingActor,
  BookingStatus,
  PaymentMethod,
  PaymentStatus,
  type IBooking,
} from '../../interfaces/IBooking';
import { NotificationType } from '../../interfaces/INotification';
import { PaymentPurpose, PaymentRecordStatus, RefundStatus, type IPayment } from '../../interfaces/IPayment';
import { logger } from '../../utils/logger/winston';
import type { Pagination } from '../../utils/response/pagination';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  PaymentFailedError,
  ServiceUnavailableError,
  ValidationError,
} from '../../utils/types-errors';
import type { AuditContext } from '../audit/audit.service';
import { AuditService } from '../audit/audit.service';
import { runBookingTransaction, transitionBooking } from '../booking/booking-transaction';
import { NotificationService } from '../notification/notification.service';
import { SettingsService } from '../settings/settings.service';
import { activeGateway, gatewayByName, InvalidWebhookSignatureError, type WebhookRequest } from './gateways';

const CARD_METHODS = [PaymentMethod.CARD, PaymentMethod.WALLET];

/**
 * Card and mobile-wallet payments (spec §4.8, §7.14), provider-agnostic: everything gateway-specific
 * sits behind `PaymentGateway`. The webhook is the only source of truth for "paid". A card / wallet
 * booking must be paid within `card_payment_window_minutes` of booking, or the sweep cancels it; any
 * cancellation, decline or expiry of a paid booking refunds it in full automatically.
 */
@Service()
export class PaymentService {
  private readonly settings = Container.get(SettingsService);
  private readonly notifications = Container.get(NotificationService);
  private readonly audit = Container.get(AuditService);

  /** Card / wallet bookings are on when the feature flag is on and a gateway is configured. */
  async cardPaymentsEnabled() {
    const features = await this.settings.get('features');
    return features.card_payment && !!activeGateway();
  }

  /** POST /payments/initiate — a fresh checkout for the caller's unpaid card / wallet booking. */
  async initiateForBooking(
    userId: string,
    bookingId: string,
    method?: PaymentMethod.CARD | PaymentMethod.WALLET,
  ) {
    const gateway = activeGateway();
    if (!gateway) throw new ServiceUnavailableError('errors.payments_unavailable');
    const booking = Types.ObjectId.isValid(bookingId)
      ? await BookingModel.findOne({ _id: bookingId, patientUserId: userId }).lean()
      : null;
    if (!booking) throw new NotFoundError('errors.booking_not_found');
    if (booking.paymentStatus === PaymentStatus.PAID) throw new ConflictError('errors.payment_already_paid');
    if (!CARD_METHODS.includes(booking.paymentMethod) || !ACTIVE_BOOKING_STATUSES.includes(booking.status)) {
      throw new ConflictError('errors.payment_not_allowed');
    }
    const deadline = await this.paymentDeadline(booking);
    if (deadline.getTime() <= Date.now()) throw new ConflictError('errors.payment_window_passed');
    // The patient may switch between card and wallet before paying.
    if (method && method !== booking.paymentMethod) {
      await BookingModel.updateOne({ _id: booking._id }, { paymentMethod: method });
      booking.paymentMethod = method;
    }

    // One live checkout at a time: earlier unfinished attempts lapse.
    await PaymentModel.updateMany(
      { bookingId: booking._id, status: PaymentRecordStatus.PENDING },
      { status: PaymentRecordStatus.EXPIRED },
    );
    const payment = await PaymentModel.create({
      purpose: PaymentPurpose.BOOKING,
      bookingId: booking._id,
      userId,
      amount: booking.price.total,
      method: booking.paymentMethod,
      gateway: gateway.name,
      expiresAt: deadline,
    });
    const user = await UserModel.findById(userId).select('fullName phone email').lean();
    const [firstName, ...rest] = (user?.fullName ?? '').trim().split(/\s+/);
    const base = `${env.payments.publicApiUrl}${env.apiPrefix}`;
    try {
      const checkout = await gateway.createCheckout({
        paymentId: String(payment._id),
        amount: payment.amount,
        method: payment.method,
        description: `${booking.service.nameAr} — ${booking.referenceCode}`,
        customer: {
          firstName,
          lastName: rest.join(' '),
          phone: user?.phone ?? '',
          email: user?.email ?? null,
        },
        webhookUrl: `${base}/webhooks/payments/${gateway.name}`,
        returnUrl: `${base}/payments/${String(payment._id)}/return`,
        expiresInSeconds: Math.max(60, Math.round((deadline.getTime() - Date.now()) / 1000)),
      });
      payment.checkoutUrl = checkout.checkoutUrl;
      payment.gatewayOrderId = checkout.gatewayOrderId;
      await payment.save();
    } catch (err) {
      logger.error(`Checkout failed for booking ${bookingId}`, err);
      payment.status = PaymentRecordStatus.FAILED;
      payment.failureReason = 'checkout_unavailable';
      await payment.save();
      throw new PaymentFailedError();
    }
    await BookingModel.updateOne(
      { _id: booking._id, paymentStatus: { $ne: PaymentStatus.PAID } },
      { paymentStatus: PaymentStatus.PENDING },
    );
    return payment.toObject();
  }

  async get(userId: string, paymentId: string) {
    const payment = Types.ObjectId.isValid(paymentId)
      ? await PaymentModel.findOne({ _id: paymentId, userId }).lean()
      : null;
    if (!payment) throw new NotFoundError('errors.payment_not_found');
    return payment;
  }

  async listMine(userId: string, pagination: Pagination) {
    const query = { userId: new Types.ObjectId(userId) };
    const [data, total] = await Promise.all([
      PaymentModel.find(query).sort({ createdAt: -1 }).skip(pagination.skip).limit(pagination.perPage).lean(),
      PaymentModel.countDocuments(query),
    ]);
    return { data, total };
  }

  async adminList(filters: { status?: PaymentRecordStatus; method?: PaymentMethod }, pagination: Pagination) {
    const query = {
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.method ? { method: filters.method } : {}),
    };
    const [data, total] = await Promise.all([
      PaymentModel.find(query).sort({ createdAt: -1 }).skip(pagination.skip).limit(pagination.perPage).lean(),
      PaymentModel.countDocuments(query),
    ]);
    return { data, total };
  }

  /**
   * POST /webhooks/payments/{gateway}. Signature first (a bad one changes nothing), then idempotent:
   * repeats of a result already applied are no-ops. Unknown payments are acknowledged and logged so
   * the gateway stops retrying.
   */
  async handleWebhook(gatewayName: string, request: WebhookRequest) {
    const gateway = gatewayByName(gatewayName);
    if (!gateway) throw new NotFoundError('errors.route_not_found');
    let event;
    try {
      event = gateway.parseWebhook(request);
    } catch (err) {
      if (err instanceof InvalidWebhookSignatureError) throw new BadRequestError('errors.invalid_signature');
      throw err;
    }
    if (event.kind === 'ignored') return { handled: false };

    const payment = await this.findForEvent(gateway.name, event.paymentId, event.gatewayOrderId);
    if (!payment) {
      logger.warn(`Webhook for unknown payment (${gateway.name} order ${event.gatewayOrderId})`);
      return { handled: false };
    }
    if (event.isFollowUp || event.status === 'refunded') return { handled: false }; // our refund flow records refunds
    if (event.status === 'voided') {
      await this.recordExternalVoid(payment);
      return { handled: true };
    }
    if (event.status === 'pending') return { handled: false };
    if (event.status === 'failed') {
      await this.markFailed(payment, event.failureReason ?? 'declined');
      return { handled: true };
    }

    // Paid.
    if (payment.status === PaymentRecordStatus.PAID && payment.gatewayTransactionId === event.transactionId) {
      return { handled: false }; // repeat delivery
    }
    if (event.amount !== payment.amount) {
      logger.error(
        `Paid amount ${event.amount} ≠ expected ${payment.amount} for payment ${String(payment._id)}`,
      );
      await this.markFailed(payment, 'amount_mismatch');
      return { handled: true };
    }
    await this.markPaid(payment, event.transactionId, event.instrument);
    return { handled: true };
  }

  /**
   * Refunds (part of) a booking's payment through its gateway. `amount` null = whatever is left.
   * Throws when the gateway refuses, so admins see it; automatic refunds log and flag instead.
   */
  async refundBooking(
    bookingId: Types.ObjectId | string,
    input: { amount: number | null; reason: string },
    context: AuditContext | null,
  ) {
    const payment = await PaymentModel.findOne({
      bookingId,
      status: { $in: [PaymentRecordStatus.PAID, PaymentRecordStatus.PARTIALLY_REFUNDED] },
    }).lean();
    if (!payment?.gatewayTransactionId) throw new ConflictError('errors.refund_not_allowed');
    const remaining = payment.amount - payment.refundedAmount;
    const amount = input.amount ?? remaining;
    if (amount <= 0 || amount > remaining)
      throw new ValidationError({ amount: ['validation.refund_amount'] });

    // Reserve the amount first so two refunds can't together exceed the payment.
    const reserved = await PaymentModel.findOneAndUpdate(
      { _id: payment._id, refundedAmount: { $lte: payment.amount - amount } },
      { $inc: { refundedAmount: amount } },
      { new: true },
    );
    if (!reserved) throw new ConflictError('errors.refund_not_allowed');
    const refund = await RefundModel.create({
      paymentId: payment._id,
      bookingId: payment.bookingId,
      amount,
      reason: input.reason,
      requestedBy: context?.actorId ?? null,
    });
    const gateway = gatewayByName(payment.gateway);
    const result = gateway
      ? await gateway
          .refund({ transactionId: payment.gatewayTransactionId, amount })
          .catch((err: unknown) => ({
            ok: false,
            refundId: null,
            error: String(err),
          }))
      : { ok: false, refundId: null, error: 'gateway not configured' };

    if (!result.ok) {
      await PaymentModel.updateOne({ _id: payment._id }, { $inc: { refundedAmount: -amount } });
      refund.status = RefundStatus.FAILED;
      refund.failureReason = ('error' in result && result.error) || 'refused';
      await refund.save();
      logger.error(`Refund of ${amount} for booking ${String(bookingId)} failed: ${refund.failureReason}`);
      throw new PaymentFailedError();
    }
    refund.status = RefundStatus.SUCCEEDED;
    refund.gatewayRefundId = result.refundId;
    await refund.save();
    const full = reserved.refundedAmount >= reserved.amount;
    await PaymentModel.updateOne(
      { _id: payment._id },
      { status: full ? PaymentRecordStatus.REFUNDED : PaymentRecordStatus.PARTIALLY_REFUNDED },
    );
    if (full)
      await BookingModel.updateOne({ _id: payment.bookingId }, { paymentStatus: PaymentStatus.REFUNDED });
    if (context) {
      await this.audit.log(context, {
        action: 'booking.refund',
        entityType: 'booking',
        entityId: String(payment.bookingId),
        metadata: { amount, reason: input.reason, refundId: String(refund._id) },
      });
    }
    await this.notifications.notify([payment.userId], {
      type: NotificationType.BOOKING_STATUS,
      template: 'payment_refunded',
      params: { amount: (amount / 100).toFixed(2) },
      data: { booking_id: String(payment.bookingId), payment_id: String(payment._id) },
    });
    return refund.toObject();
  }

  /** Sweep: card / wallet bookings still in awaiting_payment after the payment window expire (the slot frees up). */
  async expireUnpaid(now = new Date()) {
    const windowMinutes = await this.settings.get('card_payment_window_minutes');
    const cutoff = new Date(now.getTime() - windowMinutes * 60_000);
    const overdue = await BookingModel.find({
      status: BookingStatus.AWAITING_PAYMENT,
      createdAt: { $lte: cutoff },
    }).lean();
    let expired = 0;
    for (const booking of overdue) {
      try {
        await runBookingTransaction(async (tx) => {
          await transitionBooking(tx, booking, BookingStatus.EXPIRED, BookingActor.SYSTEM, {
            note: 'payment_timeout',
            reason: 'payment_timeout',
          });
        });
        await PaymentModel.updateMany(
          { bookingId: booking._id, status: PaymentRecordStatus.PENDING },
          { status: PaymentRecordStatus.EXPIRED },
        );
        expired++;
      } catch (err) {
        logger.error(`Could not expire unpaid booking ${String(booking._id)}`, err);
      }
    }
    return expired;
  }

  /** When the booking's payment window closes. */
  async paymentDeadline(booking: Pick<IBooking, 'createdAt'>) {
    const windowMinutes = await this.settings.get('card_payment_window_minutes');
    return new Date(booking.createdAt.getTime() + windowMinutes * 60_000);
  }

  private async findForEvent(gateway: string, paymentId: string | null, gatewayOrderId: string | null) {
    if (paymentId && Types.ObjectId.isValid(paymentId)) {
      const byId = await PaymentModel.findOne({ _id: paymentId, gateway }).lean();
      if (byId) return byId;
    }
    return gatewayOrderId ? PaymentModel.findOne({ gateway, gatewayOrderId }).lean() : null;
  }

  private async markPaid(payment: IPayment, transactionId: string, instrument: IPayment['instrument']) {
    const booking = await BookingModel.findById(payment.bookingId).lean();
    const alreadyPaid = await PaymentModel.exists({
      bookingId: payment.bookingId,
      status: PaymentRecordStatus.PAID,
      _id: { $ne: payment._id },
    });
    await PaymentModel.updateOne(
      { _id: payment._id },
      {
        status: alreadyPaid ? PaymentRecordStatus.REFUNDED : PaymentRecordStatus.PAID,
        gatewayTransactionId: transactionId,
        instrument,
        paidAt: new Date(),
        failureReason: null,
      },
    );
    if (alreadyPaid) {
      // A second successful charge for the same booking: give it straight back.
      await this.refundDuplicate(payment, transactionId);
      return;
    }
    const lateForBooking = !booking || !ACTIVE_BOOKING_STATUSES.includes(booking.status);
    if (booking && booking.status === BookingStatus.AWAITING_PAYMENT) {
      await this.releaseToProvider(booking);
      return;
    }
    if (booking && !lateForBooking) {
      await BookingModel.updateOne({ _id: booking._id }, { paymentStatus: PaymentStatus.PAID });
      return;
    }
    // Paid after the booking was cancelled / expired (e.g. the payment window closed mid-checkout): refund.
    await BookingModel.updateOne({ _id: payment.bookingId }, { paymentStatus: PaymentStatus.PAID });
    await this.refundBooking(
      payment.bookingId,
      { amount: null, reason: 'paid_after_booking_closed' },
      null,
    ).catch((err: unknown) =>
      logger.error(`Automatic refund failed for payment ${String(payment._id)}`, err),
    );
  }

  /** Paid: awaiting_payment → pending; the provider gets the request now and their response clock starts. */
  private async releaseToProvider(booking: IBooking) {
    const responseMinutes = await this.settings.get('direct_request_response_minutes');
    await runBookingTransaction(async (tx) => {
      const updated = await transitionBooking(tx, booking, BookingStatus.PENDING, BookingActor.SYSTEM, {
        set: {
          paymentStatus: PaymentStatus.PAID,
          assignmentDeadline: new Date(Date.now() + responseMinutes * 60_000),
        },
        note: 'paid',
        reason: 'paid',
      });
      if (updated.providerProfileId) {
        tx.publish({
          type: 'new_request',
          booking: updated.toObject(),
          providerProfileIds: [String(updated.providerProfileId)],
        });
      }
    });
  }

  private async refundDuplicate(payment: IPayment, transactionId: string) {
    const gateway = gatewayByName(payment.gateway);
    const result = await gateway?.refund({ transactionId, amount: payment.amount });
    await RefundModel.create({
      paymentId: payment._id,
      bookingId: payment.bookingId,
      amount: payment.amount,
      reason: 'duplicate_payment',
      status: result?.ok ? RefundStatus.SUCCEEDED : RefundStatus.FAILED,
      gatewayRefundId: result?.refundId ?? null,
      failureReason: result?.ok ? null : (result?.error ?? 'gateway not configured'),
    });
    await PaymentModel.updateOne({ _id: payment._id }, { refundedAmount: payment.amount });
    if (!result?.ok)
      logger.error(`Duplicate payment ${String(payment._id)} could not be refunded automatically`);
  }

  private async markFailed(payment: IPayment, reason: string) {
    const updated = await PaymentModel.findOneAndUpdate(
      { _id: payment._id, status: PaymentRecordStatus.PENDING },
      { status: PaymentRecordStatus.FAILED, failureReason: reason },
    );
    if (!updated) return;
    await BookingModel.updateOne(
      { _id: payment.bookingId, paymentStatus: PaymentStatus.PENDING },
      { paymentStatus: PaymentStatus.FAILED },
    );
  }

  /** A void done from the gateway's dashboard (same-day cancel of a card payment). */
  private async recordExternalVoid(payment: IPayment) {
    if (payment.status !== PaymentRecordStatus.PAID) return;
    await PaymentModel.updateOne(
      { _id: payment._id },
      { status: PaymentRecordStatus.REFUNDED, refundedAmount: payment.amount },
    );
    await BookingModel.updateOne({ _id: payment.bookingId }, { paymentStatus: PaymentStatus.REFUNDED });
  }
}
