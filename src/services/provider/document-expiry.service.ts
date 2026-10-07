import { Container, Service } from 'typedi';
import { ProviderDocumentModel } from '../../database/models/provider/provider-document.model';
import { ProviderProfileModel } from '../../database/models/provider/provider-profile.model';
import { DocumentReviewStatus, ProviderDocumentType } from '../../interfaces/IProvider';
import { NotificationType } from '../../interfaces/INotification';
import { invalidateCacheNamespace } from '../../utils/cache/cache';
import { formatCairoDateTime } from '../../utils/time/cairo';
import { AuditService } from '../audit/audit.service';
import { PROVIDER_PRICES_CACHE } from '../catalog/catalog.service';
import { NotificationService } from '../notification/notification.service';
import { DOCUMENT_EXPIRY_WARNING_DAYS } from '../admin/admin-dashboard.service';

/**
 * Daily document check (spec §4.4, decision 14):
 * - documents expiring within 30 days → the provider is told once (they also show in /admin/attention);
 * - an expired license → the provider stops taking bookings until a valid one is approved.
 */
@Service()
export class DocumentExpiryService {
  private readonly notifications = Container.get(NotificationService);
  private readonly audit = Container.get(AuditService);

  async processDaily(now = new Date()) {
    const horizon = new Date(now.getTime() + DOCUMENT_EXPIRY_WARNING_DAYS * 24 * 3600_000);
    let warned = 0;
    let paused = 0;

    const expiring = await ProviderDocumentModel.find({
      expiresAt: { $gt: now, $lte: horizon },
      expiryNoticeAt: null,
    }).lean();
    for (const document of expiring) {
      const claimed = await ProviderDocumentModel.updateOne(
        { _id: document._id, expiryNoticeAt: null },
        { expiryNoticeAt: now },
      );
      if (!claimed.modifiedCount) continue;
      const profile = await ProviderProfileModel.findById(document.providerProfileId).select('userId').lean();
      if (!profile) continue;
      await this.notifications.notify([profile.userId], {
        type: NotificationType.VERIFICATION_RESULT,
        template: 'document_expiring',
        params: (lang) => ({ date: formatCairoDateTime(document.expiresAt!, lang) }),
        data: { document_id: String(document._id), document_type: document.type },
      });
      warned++;
    }

    // Expired licenses: pause providers still taking bookings, unless a newer valid license exists.
    const expiredLicenses = await ProviderDocumentModel.find({
      type: ProviderDocumentType.LICENSE,
      expiresAt: { $lte: now },
    }).lean();
    for (const license of expiredLicenses) {
      const newer = await ProviderDocumentModel.exists({
        providerProfileId: license.providerProfileId,
        type: ProviderDocumentType.LICENSE,
        status: DocumentReviewStatus.MATCHING,
        $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
      });
      if (newer) continue;
      const profile = await ProviderProfileModel.findOneAndUpdate(
        { _id: license.providerProfileId, isAcceptingBookings: true },
        { isAcceptingBookings: false },
      );
      if (!profile) continue;
      paused++;
      await this.audit.log(
        { actorId: null },
        {
          action: 'provider.paused_license_expired',
          entityType: 'provider_profile',
          entityId: String(profile._id),
        },
      );
      await this.notifications.notify([profile.userId], {
        type: NotificationType.VERIFICATION_RESULT,
        template: 'license_expired',
        data: { document_id: String(license._id) },
      });
    }
    if (paused) await invalidateCacheNamespace(PROVIDER_PRICES_CACHE);
    return { warned, paused };
  }
}
