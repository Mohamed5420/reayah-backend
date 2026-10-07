import { Service } from 'typedi';
import { DeviceModel } from '../../database/models/auth/device.model';
import type { DevicePlatform } from '../../interfaces/enums';

/** FCM tokens for push (spec §4.1 `devices`, §7.2). */
@Service()
export class DeviceService {
  /** Registers or refreshes a token. A token seen under another account moves to this one (same phone, new login). */
  register(
    userId: string,
    input: { fcmToken: string; platform: DevicePlatform; appVersion?: string | null },
  ) {
    return DeviceModel.findOneAndUpdate(
      { fcmToken: input.fcmToken },
      {
        userId,
        platform: input.platform,
        appVersion: input.appVersion ?? null,
        lastSeenAt: new Date(),
      },
      { upsert: true, new: true },
    );
  }

  async remove(userId: string, fcmToken: string) {
    await DeviceModel.deleteOne({ userId, fcmToken });
  }
}
