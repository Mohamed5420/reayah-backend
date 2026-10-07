import { UserModel } from '../database/models/user/user.model';
import { logger } from '../utils/logger/winston';

export class PresenceCleanup {
  /** Reset users left "online" by a previous run that died without disconnecting sockets. */
  static async cleanStalePresence() {
    const { modifiedCount } = await UserModel.updateMany({ isOnline: true }, { $set: { isOnline: false } });
    if (modifiedCount) logger.info(`Presence cleanup: reset ${modifiedCount} stale online user(s)`);
  }
}
