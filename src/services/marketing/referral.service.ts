import { createHmac, randomInt } from 'node:crypto';
import { Container, Service } from 'typedi';
import { Types, type ClientSession } from 'mongoose';
import { env } from '../../config/env.config';
import { ReferralModel } from '../../database/models/marketing/marketing.models';
import { ProviderProfileModel } from '../../database/models/provider/provider-profile.model';
import { UserModel } from '../../database/models/user/user.model';
import { withTransaction } from '../../database/transaction';
import { UserRole } from '../../interfaces/enums';
import { LedgerEntryType, LedgerOwnerType } from '../../interfaces/ILedger';
import { ReferralStatus } from '../../interfaces/IMarketing';
import { NotificationType } from '../../interfaces/INotification';
import type { IUser } from '../../interfaces/IUser';
import { logger } from '../../utils/logger/winston';
import { NotFoundError } from '../../utils/types-errors';
import { LedgerService } from '../ledger/ledger.service';
import { NotificationService } from '../notification/notification.service';
import { SettingsService } from '../settings/settings.service';
import { CreditService } from './credit.service';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I
const CODE_LENGTH = 7;

const newCode = () =>
  Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');

/** A phone can be referred once ever (also after its account is deleted and the number reused). */
const phoneHash = (phone: string) =>
  createHmac('sha256', env.jwt.secret).update(`referral:${phone}`).digest('hex');

/**
 * Referrals (spec §4.10, §7.2 `/me/referral`; M2.5). Each user has a code; a patient who signs up with
 * one is linked to the referrer. After the referred patient's first completed booking both sides get
 * `referral_reward`: patients as in-app credit (applied to their next bookings), providers on their
 * earnings ledger.
 */
@Service()
export class ReferralService {
  private readonly settings = Container.get(SettingsService);

  /** The user's code, created on first use. */
  async codeFor(userId: string) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const user = await UserModel.findById(userId).select('referralCode').lean();
      if (!user) throw new NotFoundError('errors.user_not_found');
      if (user.referralCode) return user.referralCode;
      try {
        await UserModel.updateOne({ _id: userId, referralCode: null }, { referralCode: newCode() });
      } catch (err) {
        if ((err as { code?: number }).code !== 11000) throw err; // taken: try another
      }
    }
    throw new Error('Could not allocate a referral code');
  }

  /** GET /me/referral. */
  async summary(userId: string) {
    const code = await this.codeFor(userId);
    const id = new Types.ObjectId(userId);
    const [invitedCount, earned, creditBalance] = await Promise.all([
      ReferralModel.countDocuments({ referrerUserId: id }),
      ReferralModel.aggregate<{ total: number }>([
        {
          $match: {
            status: ReferralStatus.REWARDED,
            $or: [{ referrerUserId: id }, { referredUserId: id }],
          },
        },
        { $group: { _id: null, total: { $sum: '$rewardAmount' } } },
      ]),
      Container.get(CreditService).balance(id),
    ]);
    return {
      code,
      shareUrl: `${env.referralLinkBase}${code}`,
      invitedCount,
      rewardsEarned: earned[0]?.total ?? 0,
      creditBalance,
    };
  }

  /** At sign-up (inside the registration transaction). Unknown codes are ignored, not an error. */
  async recordAtSignup(
    session: ClientSession,
    user: Pick<IUser, '_id' | 'phone' | 'role'>,
    code?: string | null,
  ) {
    if (!code || user.role !== UserRole.PATIENT) return;
    const normalized = code.trim().toUpperCase();
    const referrer = await UserModel.findOne({ referralCode: normalized }).session(session).lean();
    if (!referrer || String(referrer._id) === String(user._id)) return;
    const hash = phoneHash(user.phone);
    if (await ReferralModel.exists({ referredPhoneHash: hash }).session(session)) return;
    await ReferralModel.create(
      [{ referrerUserId: referrer._id, referredUserId: user._id, referredPhoneHash: hash, code: normalized }],
      { session },
    );
  }

  /**
   * On the referred patient's first completed booking: claim the referral once, credit both sides in
   * one transaction, then tell them.
   */
  async rewardIfDue(patientUserId: Types.ObjectId) {
    if (!(await ReferralModel.exists({ referredUserId: patientUserId, status: ReferralStatus.PENDING })))
      return;
    const amount = await this.settings.get('referral_reward');
    const result = await withTransaction(async (session) => {
      const referral = await ReferralModel.findOneAndUpdate(
        { referredUserId: patientUserId, status: ReferralStatus.PENDING },
        { status: ReferralStatus.REWARDED, rewardAmount: amount, rewardedAt: new Date() },
        { new: true, session },
      );
      if (!referral || amount <= 0) return null;
      const note = `referral ${String(referral._id)}`;
      await Container.get(CreditService).grant(patientUserId, amount, note, session);
      const referrer = await UserModel.findById(referral.referrerUserId).session(session).lean();
      let referrerRewarded = false;
      if (referrer?.role === UserRole.PATIENT) {
        await Container.get(CreditService).grant(referrer._id, amount, note, session);
        referrerRewarded = true;
      } else if (referrer?.role === UserRole.PROVIDER) {
        const profile = await ProviderProfileModel.findOne({ userId: referrer._id }).session(session).lean();
        if (profile) {
          await Container.get(LedgerService).record(
            {
              ownerType: LedgerOwnerType.PROVIDER,
              ownerId: profile._id,
              bookingId: null,
              type: LedgerEntryType.REFERRAL_REWARD,
              amount,
              note,
            },
            session,
          );
          referrerRewarded = true;
        }
      }
      return { referrerId: referrerRewarded ? referrer!._id : null };
    });
    if (!result) return;
    // Money received: an account notification, pushed even with promotions turned off.
    const notifications = Container.get(NotificationService);
    const params = { amount: (amount / 100).toFixed(2) };
    await notifications.notify([patientUserId], {
      type: NotificationType.ACCOUNT,
      template: 'referral_reward_referred',
      params,
      data: {},
    });
    if (result.referrerId) {
      await notifications.notify([result.referrerId], {
        type: NotificationType.ACCOUNT,
        template: 'referral_reward_referrer',
        params,
        data: {},
      });
    }
  }
}

export const rewardReferralSafely = (patientUserId: Types.ObjectId) =>
  Container.get(ReferralService)
    .rewardIfDue(patientUserId)
    .catch((err: unknown) => logger.error(`Referral reward failed for ${String(patientUserId)}`, err));
