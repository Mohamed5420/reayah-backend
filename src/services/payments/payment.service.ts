import { Container, Service } from 'typedi';
import { Types, type HydratedDocument } from 'mongoose';
import { env } from '../../config/env.config';
import { BookingModel } from '../../database/models/booking/booking.model';
import { PaymentModel, RefundModel } from '../../database/models/payment/payment.models';
import { UserModel } from '../../database/models/user/user.model';
import {
  ACTIVE_BOOKING_STATUSES,
  AssignmentMode,
  BookingActor,
  BookingStatus,
  PaymentMethod,
  PaymentStatus,
  type IBooking,
} from '../../interfaces/IBooking';
import { NotificationType } from '../../interfaces/INotification';
import { LedgerEntryType, LedgerOwnerType } from '../../interfaces/ILedger';
import { withTransaction } from '../../database/transaction';
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
import { requestEventFor } from '../booking/booking.service';
import { NotificationService } from '../notification/notification.service';
import { LedgerService } from '../ledger/ledger.service';
import { CommissionService } from '../payouts/commission.service';
import { SettingsService } from '../settings/settings.service';
import { PackageService } from '../marketing/package.service';
import { SubscriptionService } from '../organization/subscription.service';
import { PackageSubscriptionStatus } from '../../interfaces/IMarketing';
import { activeGateway, gatewayByName, InvalidWebhookSignatureError, type WebhookRequest } from './gateways';

const CARD_METHODS = [PaymentMethod.CARD, PaymentMethod.WALLET];
/** How long a commission checkout stays open. */
const COMMISSION_CHECKOUT_MINUTES = 30;

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
    await this.startCheckout(
      payment,
      `${booking.service.nameAr} — ${booking.referenceCode}`,
      userId,
      deadline,
    );
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

  /**
   * Sweep: card / wallet bookings still in awaiting_payment after the payment window expire (the slot
   * frees up); unpaid package purchases are cancelled.
   */
  async expireUnpaid(now = new Date()) {
    await Container.get(PackageService).cancelUnpaid(now);
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
    if (payment.purpose === PaymentPurpose.COMMISSION) {
      await this.creditCommissionPayment(payment, transactionId, instrument);
      return;
    }
    if (payment.purpose === PaymentPurpose.PACKAGE) {
      await this.activatePackage(payment, transactionId, instrument);
      return;
    }
    if (payment.purpose === PaymentPurpose.PLAN_FEE) {
      await this.settlePlanFees(payment, transactionId, instrument);
      return;
    }
    const bookingId = payment.bookingId!;
    const booking = await BookingModel.findById(bookingId).lean();
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
      await this.refundWhole(payment, transactionId, 'duplicate_payment');
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
    await BookingModel.updateOne({ _id: bookingId }, { paymentStatus: PaymentStatus.PAID });
    await this.refundBooking(bookingId, { amount: null, reason: 'paid_after_booking_closed' }, null).catch(
      (err: unknown) => logger.error(`Automatic refund failed for payment ${String(payment._id)}`, err),
    );
  }

  /**
   * A provider's commission payment succeeded: mark it paid and credit their ledger in one transaction
   * (the conditional update makes a repeat delivery a no-op). Then tell them.
   */
  private async creditCommissionPayment(
    payment: IPayment,
    transactionId: string,
    instrument: IPayment['instrument'],
  ) {
    const owner = payment.organizationId
      ? { ownerType: LedgerOwnerType.ORGANIZATION, ownerId: payment.organizationId }
      : { ownerType: LedgerOwnerType.PROVIDER, ownerId: payment.providerProfileId! };
    const credited = await withTransaction(async (session) => {
      const updated = await PaymentModel.findOneAndUpdate(
        { _id: payment._id, status: { $ne: PaymentRecordStatus.PAID } },
        {
          status: PaymentRecordStatus.PAID,
          gatewayTransactionId: transactionId,
          instrument,
          paidAt: new Date(),
          failureReason: null,
        },
        { new: true, session },
      );
      if (!updated) return false;
      await Container.get(LedgerService).record(
        {
          ...owner,
          bookingId: null,
          type: LedgerEntryType.COMMISSION_PAYMENT,
          amount: payment.amount,
          note: `payment ${String(payment._id)}`,
        },
        session,
      );
      return true;
    });
    if (!credited) return;
    await this.notifications.notify([payment.userId], {
      type: NotificationType.PAYOUT,
      template: 'commission_paid',
      params: { amount: (payment.amount / 100).toFixed(2) },
      data: { payment_id: String(payment._id) },
    });
  }

  /**
   * A package purchase was paid: the payment is marked paid and the subscription starts, in one
   * transaction (a repeat delivery changes nothing). Paid after the purchase was cancelled for
   * non-payment, or twice: refunded in full.
   */
  private async activatePackage(
    payment: IPayment,
    transactionId: string,
    instrument: IPayment['instrument'],
  ) {
    const outcome = await withTransaction(async (session) => {
      const updated = await PaymentModel.findOneAndUpdate(
        { _id: payment._id, status: { $ne: PaymentRecordStatus.PAID } },
        {
          status: PaymentRecordStatus.PAID,
          gatewayTransactionId: transactionId,
          instrument,
          paidAt: new Date(),
          failureReason: null,
        },
        { new: true, session },
      );
      if (!updated) return 'repeat' as const;
      const sub = await Container.get(PackageService).activate(
        session,
        payment.packageSubscriptionId!,
        payment._id,
      );
      return sub ?? ('late' as const);
    });
    if (outcome === 'repeat') return;
    if (outcome === 'late') {
      await this.refundWhole(payment, transactionId, 'paid_after_purchase_closed');
      return;
    }
    await Container.get(PackageService).notifyActivated(outcome);
  }

  /**
   * POST /packages/{id}/subscribe (after the subscription is created) and POST /payments/initiate with
   * purpose `package`: a checkout for an unpaid package purchase, within the payment window.
   */
  async initiateForPackage(
    userId: string,
    subscriptionId: string,
    method: PaymentMethod.CARD | PaymentMethod.WALLET,
  ) {
    const gateway = activeGateway();
    if (!gateway) throw new ServiceUnavailableError('errors.payments_unavailable');
    const packages = Container.get(PackageService);
    const sub = await packages.getOwned(userId, subscriptionId);
    if (!sub) throw new NotFoundError('errors.package_subscription_not_found');
    if (sub.status !== PackageSubscriptionStatus.PENDING_PAYMENT) {
      throw new ConflictError('errors.payment_not_allowed');
    }
    const deadline = await packages.paymentDeadline(sub);
    if (deadline.getTime() <= Date.now()) throw new ConflictError('errors.payment_window_passed');

    await PaymentModel.updateMany(
      { packageSubscriptionId: sub._id, status: PaymentRecordStatus.PENDING },
      { status: PaymentRecordStatus.EXPIRED },
    );
    const payment = await PaymentModel.create({
      purpose: PaymentPurpose.PACKAGE,
      packageSubscriptionId: sub._id,
      userId,
      amount: sub.package.price,
      method,
      gateway: gateway.name,
      expiresAt: deadline,
    });
    await this.startCheckout(payment, sub.package.nameAr, userId, deadline);
    return payment.toObject();
  }

  /**
   * POST /provider/commission/pay and /org/commission/pay — a checkout for (part of) what the provider or
   * organization owes (cash commission; for organizations also plan fees). `amount` defaults to everything
   * owed; at least 1 EGP.
   */
  async initiateCommissionPayment(
    userId: string,
    of: Types.ObjectId | { ownerType: LedgerOwnerType; ownerId: Types.ObjectId },
    input: { amount?: number; method: PaymentMethod.CARD | PaymentMethod.WALLET },
  ) {
    const owner = of instanceof Types.ObjectId ? { ownerType: LedgerOwnerType.PROVIDER, ownerId: of } : of;
    const gateway = activeGateway();
    if (!gateway) throw new ServiceUnavailableError('errors.payments_unavailable');
    const { due } = await Container.get(CommissionService).status(owner.ownerId, owner.ownerType);
    if (due <= 0) throw new ConflictError('errors.no_commission_due');
    const amount = input.amount ?? due;
    if (amount < 100 || amount > due) throw new ValidationError({ amount: ['validation.commission_amount'] });

    const expiresAt = new Date(Date.now() + COMMISSION_CHECKOUT_MINUTES * 60_000);
    const payment = await PaymentModel.create({
      purpose: PaymentPurpose.COMMISSION,
      ...(owner.ownerType === LedgerOwnerType.ORGANIZATION
        ? { organizationId: owner.ownerId }
        : { providerProfileId: owner.ownerId }),
      userId,
      amount,
      method: input.method,
      gateway: gateway.name,
      expiresAt,
    });
    await this.startCheckout(payment, 'عمولة رعاية+ المستحقة', userId, expiresAt);
    return payment.toObject();
  }

  /** POST /org/subscription/pay — a checkout for everything the organization owes in plan fees. */
  async initiatePlanFeePayment(
    userId: string,
    organizationId: Types.ObjectId,
    method: PaymentMethod.CARD | PaymentMethod.WALLET,
  ) {
    const gateway = activeGateway();
    if (!gateway) throw new ServiceUnavailableError('errors.payments_unavailable');
    const { amount } = await Container.get(SubscriptionService).unpaid(organizationId);
    if (amount < 100) throw new ConflictError('errors.no_plan_fee_due');
    const expiresAt = new Date(Date.now() + COMMISSION_CHECKOUT_MINUTES * 60_000);
    const payment = await PaymentModel.create({
      purpose: PaymentPurpose.PLAN_FEE,
      organizationId,
      userId,
      amount,
      method,
      gateway: gateway.name,
      expiresAt,
    });
    await this.startCheckout(payment, 'رسوم باقة رعاية+', userId, expiresAt);
    return payment.toObject();
  }

  /** A plan-fee payment succeeded: paid once (conditional), charges settled oldest first; any excess → the balance. */
  private async settlePlanFees(payment: IPayment, transactionId: string, instrument: IPayment['instrument']) {
    const organizationId = payment.organizationId!;
    const done = await withTransaction(async (session) => {
      const updated = await PaymentModel.findOneAndUpdate(
        { _id: payment._id, status: { $ne: PaymentRecordStatus.PAID } },
        {
          status: PaymentRecordStatus.PAID,
          gatewayTransactionId: transactionId,
          instrument,
          paidAt: new Date(),
          failureReason: null,
        },
        { new: true, session },
      );
      if (!updated) return false;
      const settled = await Container.get(SubscriptionService).settleFromPayment(
        session,
        organizationId,
        payment.amount,
      );
      // Paid more than was still owed (e.g. a fee was taken from earnings meanwhile): it goes to the balance.
      if (payment.amount > settled) {
        await Container.get(LedgerService).record(
          {
            ownerType: LedgerOwnerType.ORGANIZATION,
            ownerId: organizationId,
            bookingId: null,
            type: LedgerEntryType.ADJUSTMENT,
            amount: payment.amount - settled,
            note: `plan fee overpaid: payment ${String(payment._id)}`,
          },
          session,
        );
      }
      return true;
    });
    if (!done) return;
    await this.notifications.notify([payment.userId], {
      type: NotificationType.PAYOUT,
      template: 'plan_fee_paid',
      params: { amount: (payment.amount / 100).toFixed(2) },
      data: { payment_id: String(payment._id) },
    });
  }

  /** Opens the gateway checkout for a just-created payment; marks it failed if the gateway refuses. */
  private async startCheckout(
    payment: HydratedDocument<IPayment>,
    description: string,
    userId: string,
    deadline: Date,
  ) {
    const gateway = gatewayByName(payment.gateway)!;
    const user = await UserModel.findById(userId).select('fullName phone email').lean();
    const [firstName, ...rest] = (user?.fullName ?? '').trim().split(/\s+/);
    const base = `${env.payments.publicApiUrl}${env.apiPrefix}`;
    try {
      const checkout = await gateway.createCheckout({
        paymentId: String(payment._id),
        amount: payment.amount,
        method: payment.method,
        description,
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
      logger.error(`Checkout failed for payment ${String(payment._id)}`, err);
      payment.status = PaymentRecordStatus.FAILED;
      payment.failureReason = 'checkout_unavailable';
      await payment.save();
      throw new PaymentFailedError();
    }
  }

  /** Paid: awaiting_payment → pending; the provider gets the request now and their response clock starts. */
  private async releaseToProvider(booking: IBooking) {
    const responseMinutes = await this.settings.get(
      booking.assignmentMode === AssignmentMode.ORGANIZATION
        ? 'org_assign_deadline_minutes'
        : 'direct_request_response_minutes',
    );
    await runBookingTransaction(async (tx) => {
      const updated = await transitionBooking(tx, booking, BookingStatus.PENDING, BookingActor.SYSTEM, {
        set: {
          paymentStatus: PaymentStatus.PAID,
          assignmentDeadline: new Date(Date.now() + responseMinutes * 60_000),
        },
        note: 'paid',
        reason: 'paid',
      });
      tx.publish(requestEventFor(updated.toObject()));
    });
  }

  /** Gives a whole payment back (a duplicate charge, or a payment for something already closed). */
  private async refundWhole(payment: IPayment, transactionId: string, reason: string) {
    const gateway = gatewayByName(payment.gateway);
    const result = await gateway
      ?.refund({ transactionId, amount: payment.amount })
      .catch((err: unknown) => ({ ok: false, refundId: null, error: String(err) }));
    await RefundModel.create({
      paymentId: payment._id,
      bookingId: payment.bookingId,
      amount: payment.amount,
      reason,
      status: result?.ok ? RefundStatus.SUCCEEDED : RefundStatus.FAILED,
      gatewayRefundId: result?.refundId ?? null,
      failureReason: result?.ok ? null : (result?.error ?? 'gateway not configured'),
    });
    await PaymentModel.updateOne(
      { _id: payment._id },
      {
        refundedAmount: payment.amount,
        ...(result?.ok ? { status: PaymentRecordStatus.REFUNDED } : {}),
      },
    );
    if (!result?.ok)
      logger.error(`Payment ${String(payment._id)} (${reason}) could not be refunded automatically`);
  }

  private async markFailed(payment: IPayment, reason: string) {
    const updated = await PaymentModel.findOneAndUpdate(
      { _id: payment._id, status: PaymentRecordStatus.PENDING },
      { status: PaymentRecordStatus.FAILED, failureReason: reason },
    );
    if (!updated || !payment.bookingId) return;
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
