import { Container, Service } from 'typedi';
import { UserModel } from '../../database/models/user/user.model';
import { OtpPurpose } from '../../interfaces/IAuth';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/types-errors';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { OtpService } from './otp.service';

const assertPhoneAvailable = async (userId: string, newPhone: string) => {
  const user = await UserModel.findById(userId).lean();
  if (!user) throw new NotFoundError('errors.user_not_found');
  if (user.phone === newPhone) throw new ValidationError({ new_phone: ['validation.phone_unchanged'] });
  if (await UserModel.exists({ phone: newPhone })) throw new ConflictError('errors.phone_taken');
  return user;
};

/** POST /auth/phone/change/request — sends a code to the *new* number, bound to this account. */
@Service()
export class RequestPhoneChangeUseCase {
  private readonly otp = Container.get(OtpService);

  async execute(userId: string, newPhone: string, ip: string) {
    await assertPhoneAvailable(userId, newPhone);
    return this.otp.send(newPhone, OtpPurpose.PHONE_CHANGE, ip, userId);
  }
}

/** POST /auth/phone/change/verify — proves ownership of the new number, then switches to it. Audited. */
@Service()
export class VerifyPhoneChangeUseCase {
  private readonly otp = Container.get(OtpService);
  private readonly audit = Container.get(AuditService);

  async execute(userId: string, newPhone: string, code: string, context: AuditContext) {
    const before = await assertPhoneAvailable(userId, newPhone);
    await this.otp.verify(newPhone, OtpPurpose.PHONE_CHANGE, code, userId, context.ip);

    // The unique index still guards the race where someone else takes the number right now (→ 409).
    const user = await UserModel.findByIdAndUpdate(userId, { phone: newPhone }, { new: true });
    if (!user) throw new NotFoundError('errors.user_not_found');
    await this.audit.log(context, {
      action: 'user.phone_change',
      entityType: 'user',
      entityId: userId,
      metadata: { from: before.phone, to: newPhone },
    });
    return user;
  }
}
