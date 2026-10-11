import { OrganizationModel } from '../../database/models/organization/organization.models';
import { Container, Service } from 'typedi';
import { UserModel } from '../../database/models/user/user.model';
import { ClinicModel } from '../../database/models/clinic/clinic.model';
import { NotificationModel } from '../../database/models/notification/notification.model';
import { ProviderProfileModel } from '../../database/models/provider/provider-profile.model';
import { UserRole } from '../../interfaces/enums';
import { logger } from '../../utils/logger/winston';
import { NotFoundError } from '../../utils/types-errors';
import { StorageService } from '../storage/storage.service';

const PROVIDER_ROLES: UserRole[] = [UserRole.PROVIDER, UserRole.PROVIDER_STAFF];

@Service()
export class UserService {
  private readonly storage = Container.get(StorageService);

  /** The account plus what `GET /me` shows: role summary and a signed avatar URL. */
  async getMe(userId: string) {
    const user = await UserModel.findById(userId);
    if (!user) throw new NotFoundError('errors.user_not_found');
    const desk = user.role === UserRole.RECEPTION ? user.reception : null;
    const [providerProfile, avatarUrl, unreadNotifications, organization, deskOrg, deskBranch] =
      await Promise.all([
        PROVIDER_ROLES.includes(user.role) ? ProviderProfileModel.findOne({ userId: user._id }) : null,
        user.avatarKey ? this.storage.signedUrl(user.avatarKey) : null,
        NotificationModel.countDocuments({ userId, readAt: null }),
        user.role === UserRole.OWNER ? OrganizationModel.findOne({ ownerUserId: user._id }).lean() : null,
        desk ? OrganizationModel.findById(desk.organizationId).select('name').lean() : null,
        desk ? ClinicModel.findById(desk.clinicId).select('name').lean() : null,
      ]);
    // Reception: the organization and the one branch this desk works for.
    const reception =
      deskOrg && deskBranch
        ? {
            organization: { id: String(deskOrg._id), name: deskOrg.name },
            branch: { id: String(deskBranch._id), name: deskBranch.name },
          }
        : null;
    return { user, providerProfile, avatarUrl, unreadNotifications, organization, reception };
  }

  /** POST /me/avatar: stores the (already type-checked) image and replaces the previous one. */
  async setAvatar(userId: string, file: { buffer: Buffer; mimetype: string }) {
    const user = await UserModel.findById(userId);
    if (!user) throw new NotFoundError('errors.user_not_found');
    const previous = user.avatarKey;
    user.avatarKey = await this.storage.put(`avatars/${userId}`, file.buffer, file.mimetype);
    await user.save();
    if (previous) {
      await this.storage
        .delete(previous)
        .catch((err: unknown) => logger.warn(`Failed to delete old avatar ${previous}`, err));
    }
    return this.getMe(userId);
  }

  setOnline(userId: string, isOnline: boolean) {
    return UserModel.updateOne({ _id: userId }, { $set: { isOnline } });
  }
}
