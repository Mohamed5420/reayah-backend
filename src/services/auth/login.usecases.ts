import { Container, Service } from 'typedi';
import { UserModel } from '../../database/models/user/user.model';
import { DeviceModel } from '../../database/models/auth/device.model';
import { UserStatus } from '../../interfaces/enums';
import { OtpPurpose } from '../../interfaces/IAuth';
import { AccountSuspendedError } from '../../utils/types-errors';
import { OtpService } from './otp.service';
import { TokenService } from './token.service';
import { signRegistrationToken } from './jwt';

/** POST /auth/otp/request */
@Service()
export class RequestLoginOtpUseCase {
  private readonly otp = Container.get(OtpService);

  execute(phone: string, ip: string) {
    return this.otp.send(phone, OtpPurpose.LOGIN, ip);
  }
}

/**
 * POST /auth/otp/verify — existing users get a session; new numbers get a registration token
 * (proof of phone ownership) to finish sign-up with.
 */
@Service()
export class VerifyLoginOtpUseCase {
  private readonly otp = Container.get(OtpService);
  private readonly tokens = Container.get(TokenService);

  async execute(phone: string, code: string, ip?: string) {
    await this.otp.verify(phone, OtpPurpose.LOGIN, code, undefined, ip);

    const user = await UserModel.findOne({ phone });
    if (!user) {
      return { isNewUser: true as const, registrationToken: signRegistrationToken(phone) };
    }
    if (user.status !== UserStatus.ACTIVE) throw new AccountSuspendedError();

    user.lastLoginAt = new Date();
    await user.save();
    return { isNewUser: false as const, user, tokens: await this.tokens.startSession(user) };
  }
}

/** POST /auth/logout — ends the session and forgets the device's push token. Always succeeds. */
@Service()
export class LogoutUseCase {
  private readonly tokens = Container.get(TokenService);

  async execute(refreshToken: string, fcmToken?: string) {
    const userId = await this.tokens.revokeSession(refreshToken);
    if (userId && fcmToken) await DeviceModel.deleteOne({ userId, fcmToken });
  }
}
