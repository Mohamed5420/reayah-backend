import { Container, Service } from 'typedi';
import type { Types } from 'mongoose';
import { WalletBalanceModel } from '../../database/models/ledger/wallet.model';
import { ProviderProfileModel } from '../../database/models/provider/provider-profile.model';
import { bookingEvents, type BookingEvent } from '../../events/booking.events';
import { BookingStatus, PaymentMethod } from '../../interfaces/IBooking';
import { LedgerOwnerType } from '../../interfaces/ILedger';
import { NotificationType } from '../../interfaces/INotification';
import { logger } from '../../utils/logger/winston';
import { NotificationService } from '../notification/notification.service';
import { SettingsService } from '../settings/settings.service';

const PROVIDER = LedgerOwnerType.PROVIDER;

export type CommissionStatus = {
  /** What the provider owes the platform now (piastres, ≥ 0). */
  due: number;
  limit: number;
  /** At or above the warning share of the limit. */
  warning: boolean;
  /** Above the limit: no new cash bookings until paid down. */
  overLimit: boolean;
};

/**
 * Commission owed on cash bookings (product decision after M2.4). Above `max_commission_due` a provider
 * stops receiving new cash bookings (card / wallet still fine) until they pay it down — from the app via
 * the payment gateway, or by netting at payout. They are warned at `commission_warning_percent`.
 */
@Service()
export class CommissionService {
  private readonly settings = Container.get(SettingsService);

  async status(providerProfileId: Types.ObjectId | string): Promise<CommissionStatus> {
    const [limit, percent, wallet] = await Promise.all([
      this.settings.get('max_commission_due'),
      this.settings.get('commission_warning_percent'),
      WalletBalanceModel.findOne({ ownerType: PROVIDER, ownerId: providerProfileId }).lean(),
    ]);
    const due = Math.max(-(wallet?.balance ?? 0), 0);
    return { due, limit, warning: due >= (limit * percent) / 100, overLimit: due > limit };
  }

  /** max_commission_due (piastres). */
  limit() {
    return this.settings.get('max_commission_due');
  }

  async overLimit(providerProfileId: Types.ObjectId | string) {
    return (await this.status(providerProfileId)).overLimit;
  }

  /** The subset of providers that may not take a new cash booking right now. */
  async overLimitAmong(providerProfileIds: Types.ObjectId[]) {
    const limit = await this.settings.get('max_commission_due');
    const wallets = await WalletBalanceModel.find({
      ownerType: PROVIDER,
      ownerId: { $in: providerProfileIds },
      balance: { $lt: -limit },
    })
      .select('ownerId')
      .lean();
    return new Set(wallets.map((w) => String(w.ownerId)));
  }
}

/**
 * After a cash visit adds commission due, tells the provider when they cross the warning level and
 * when they cross the limit (once per crossing, not on every visit). Registered in `runServer`.
 */
export const registerCommissionAlerts = () => {
  bookingEvents.subscribe((event) => alertOnCommission(event));
};

export const alertOnCommission = async (event: BookingEvent) => {
  if (event.type !== 'status_changed' || event.to !== BookingStatus.COMPLETED) return;
  const booking = event.booking;
  if (booking.paymentMethod !== PaymentMethod.CASH || !booking.providerProfileId) return;
  const commission = booking.price.commissionAmount;
  if (commission <= 0) return;
  try {
    const now = await Container.get(CommissionService).status(booking.providerProfileId);
    const before = now.due - commission;
    const percent = await Container.get(SettingsService).get('commission_warning_percent');
    const warnAt = (now.limit * percent) / 100;
    const template =
      before <= now.limit && now.overLimit
        ? 'commission_limit_reached'
        : before < warnAt && now.warning
          ? 'commission_due_warning'
          : null;
    if (!template) return;
    const profile = await ProviderProfileModel.findById(booking.providerProfileId).select('userId').lean();
    if (!profile) return;
    await Container.get(NotificationService).notify([profile.userId], {
      type: NotificationType.PAYOUT,
      template,
      params: { due: (now.due / 100).toFixed(2), limit: (now.limit / 100).toFixed(2) },
      data: { commission_due: String(now.due) },
    });
  } catch (err) {
    logger.error(`Commission alert failed for booking ${String(booking._id)}`, err);
  }
};
