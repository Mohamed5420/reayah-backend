import { Container, Service } from 'typedi';
import { UserModel } from '../../database/models/user/user.model';
import { DeviceModel } from '../../database/models/auth/device.model';
import { UserStatus } from '../../interfaces/enums';
import { ConflictError, NotFoundError } from '../../utils/types-errors';
import { BookingModel } from '../../database/models/booking/booking.model';
import { ProviderProfileModel } from '../../database/models/provider/provider-profile.model';
import { ACTIVE_BOOKING_STATUSES } from '../../interfaces/IBooking';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { TokenService } from '../auth/token.service';

/**
 * DELETE /me (spec §7.2): the account is closed immediately — sessions and push tokens are dropped and
 * the phone number is freed for a new sign-up. Personal data is kept until the retention job anonymises it
 * (spec §12.9: default 30 days, job not built yet).
 * Refused while the user has active bookings, as patient or provider (spec §7.2).
 */
@Service()
export class DeleteAccountUseCase {
  private readonly tokens = Container.get(TokenService);
  private readonly audit = Container.get(AuditService);

  async execute(userId: string, reason: string | undefined, context: AuditContext) {
    const user = await UserModel.findById(userId);
    if (!user) throw new NotFoundError('errors.user_not_found');
    const providerProfile = await ProviderProfileModel.findOne({ userId }).select('_id').lean();
    const active = await BookingModel.exists({
      status: { $in: ACTIVE_BOOKING_STATUSES },
      $or: [
        { patientUserId: userId },
        ...(providerProfile ? [{ providerProfileId: providerProfile._id }] : []),
      ],
    });
    if (active) throw new ConflictError('errors.active_bookings');

    user.status = UserStatus.DELETED;
    user.deletionRequestedAt = new Date();
    user.isOnline = false;
    await user.softDelete();

    await this.tokens.revokeAllForUser(userId);
    await DeviceModel.deleteMany({ userId });
    await this.audit.log(context, {
      action: 'user.delete_request',
      entityType: 'user',
      entityId: userId,
      metadata: { reason: reason ?? null },
    });
    return { deletionRequestedAt: user.deletionRequestedAt };
  }
}
