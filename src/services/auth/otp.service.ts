import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { Container, Service } from 'typedi';
import { Types } from 'mongoose';
import { OtpCodeModel } from '../../database/models/auth/otp-code.model';
import { OtpPurpose } from '../../interfaces/IAuth';
import { env } from '../../config/env.config';
import { getRedis } from '../../config/redis.config';
import { isOverLimit } from '../../utils/rate-limit';
import { t } from '../../utils/i18n';
import {
  OtpExpiredError,
  OtpInvalidError,
  OtpMaxAttemptsError,
  TooManyRequestsError,
} from '../../utils/types-errors';
import { SmsService } from '../sms/sms.service';
import { OTP } from './auth.constants';
import { fixedCodeAllowed } from './test-accounts';
import { AuditService } from '../audit/audit.service';

const hashCode = (phone: string, purpose: OtpPurpose, code: string) =>
  createHmac('sha256', env.jwt.secret).update(`otp:${purpose}:${phone}:${code}`).digest('hex');

/**
 * One-time codes over SMS (spec §7.1, §9): short expiry, attempt cap, and rate limits per phone and per IP.
 * Only an HMAC of the code is stored.
 */
@Service()
export class OtpService {
  private readonly sms = Container.get(SmsService);
  private readonly audit = Container.get(AuditService);

  /** Sends a new code (any previous unused code for the same phone + purpose stops working). */
  async send(phone: string, purpose: OtpPurpose, ip: string, userId?: string) {
    const redis = getRedis();
    const cooldown = await redis.set(
      `otp:cooldown:${purpose}:${phone}`,
      '1',
      'EX',
      OTP.RESEND_AFTER_SECONDS,
      'NX',
    );
    if (!cooldown) throw new TooManyRequestsError('errors.otp_resend_wait');
    if (
      (await isOverLimit(`otp:phone:${phone}`, OTP.PER_PHONE.limit, OTP.PER_PHONE.windowSeconds)) ||
      (await isOverLimit(`otp:ip:${ip}`, OTP.PER_IP.limit, OTP.PER_IP.windowSeconds))
    ) {
      throw new TooManyRequestsError();
    }

    // Allowlisted test numbers get the fixed code instead of an SMS (rules in test-accounts.ts); audited.
    const fixed = await fixedCodeAllowed(phone, purpose, userId);
    const code = fixed
      ? env.testAccounts.code
      : randomInt(0, 10 ** OTP.LENGTH)
          .toString()
          .padStart(OTP.LENGTH, '0');
    await OtpCodeModel.updateMany({ phone, purpose, consumedAt: null }, { consumedAt: new Date() });
    await OtpCodeModel.create({
      phone,
      purpose,
      userId: userId ? new Types.ObjectId(userId) : null,
      codeHash: hashCode(phone, purpose, code),
      expiresAt: new Date(Date.now() + OTP.TTL_SECONDS * 1000),
      fixedCode: fixed,
    });

    if (fixed) {
      await this.audit.log(
        { actorId: userId ?? null, ip },
        { action: 'auth.test_code_issued', entityType: 'phone', metadata: { phone, purpose } },
      );
      return { expires_in: OTP.TTL_SECONDS, resend_after: OTP.RESEND_AFTER_SECONDS };
    }
    const messageKey = purpose === OtpPurpose.LOGIN ? 'sms.otp_login' : 'sms.otp_phone_change';
    await this.sms.send(phone, t(messageKey, { code }));
    return { expires_in: OTP.TTL_SECONDS, resend_after: OTP.RESEND_AFTER_SECONDS };
  }

  /**
   * Checks and consumes the latest code. Each check spends an attempt atomically *before* comparing,
   * so parallel guesses can't exceed the cap.
   */
  async verify(phone: string, purpose: OtpPurpose, code: string, userId?: string, ip?: string) {
    const otp = await OtpCodeModel.findOne({
      phone,
      purpose,
      consumedAt: null,
      ...(userId ? { userId } : {}),
    }).sort({ createdAt: -1 });

    if (!otp) throw new OtpInvalidError();
    if (otp.expiresAt.getTime() <= Date.now()) throw new OtpExpiredError();

    const counted = await OtpCodeModel.findOneAndUpdate(
      { _id: otp._id, consumedAt: null, attempts: { $lt: OTP.MAX_ATTEMPTS } },
      { $inc: { attempts: 1 } },
      { new: true },
    );
    if (!counted) throw new OtpMaxAttemptsError();

    const expected = Buffer.from(otp.codeHash, 'hex');
    const actual = Buffer.from(hashCode(phone, purpose, code), 'hex');
    if (!timingSafeEqual(expected, actual)) {
      throw counted.attempts >= OTP.MAX_ATTEMPTS ? new OtpMaxAttemptsError() : new OtpInvalidError();
    }

    const consumed = await OtpCodeModel.updateOne(
      { _id: otp._id, consumedAt: null },
      { consumedAt: new Date() },
    );
    if (consumed.modifiedCount === 0) throw new OtpInvalidError(); // used by a parallel request
    if (otp.fixedCode) {
      await this.audit.log(
        { actorId: userId ?? null, ip },
        { action: 'auth.test_code_used', entityType: 'phone', metadata: { phone, purpose } },
      );
    }
  }
}
