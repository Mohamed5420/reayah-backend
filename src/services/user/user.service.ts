import { Container, Service } from 'typedi';
import { UserModel } from '../../database/models/user/user.model';
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
    const [providerProfile, avatarUrl, unreadNotifications] = await Promise.all([
      PROVIDER_ROLES.includes(user.role) ? ProviderProfileModel.findOne({ userId: user._id }) : null,
      user.avatarKey ? this.storage.signedUrl(user.avatarKey) : null,
      NotificationModel.countDocuments({ userId, readAt: null }),
    ]);
    return { user, providerProfile, avatarUrl, unreadNotifications };
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
