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
import { ClinicService } from '../clinic/clinic.service';
import { SettingsService } from '../settings/settings.service';
import {
  OrganizationDocumentModel,
  OrganizationModel,
} from '../../database/models/organization/organization.models';
import { OrganizationDocumentType } from '../../interfaces/IOrganization';

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

    // Expired licenses (and criminal records while they are required): pause providers still taking
    // bookings, unless a newer valid one of the same type was approved.
    const pausing = [ProviderDocumentType.LICENSE];
    if (await Container.get(SettingsService).get('criminal_record_required')) {
      pausing.push(ProviderDocumentType.CRIMINAL_RECORD);
    }
    const expiredLicenses = await ProviderDocumentModel.find({
      type: { $in: pausing },
      expiresAt: { $lte: now },
    }).lean();
    for (const license of expiredLicenses) {
      const newer = await ProviderDocumentModel.exists({
        providerProfileId: license.providerProfileId,
        type: license.type,
        status: DocumentReviewStatus.MATCHING,
        $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
      });
      if (newer) continue;
      const profile = await ProviderProfileModel.findOneAndUpdate(
        {
          _id: license.providerProfileId,
          $or: [{ isAcceptingBookings: true }, { acceptingResumesAt: { $ne: null } }],
        },
        { isAcceptingBookings: false, acceptingResumesAt: null },
      );
      if (!profile) continue;
      paused++;
      await this.audit.log(
        { actorId: null },
        {
          action: 'provider.paused_license_expired',
          entityType: 'provider_profile',
          entityId: String(profile._id),
          metadata: { documentType: license.type },
        },
      );
      await this.notifications.notify([profile.userId], {
        type: NotificationType.VERIFICATION_RESULT,
        template:
          license.type === ProviderDocumentType.LICENSE ? 'license_expired' : 'criminal_record_expired',
        data: { document_id: String(license._id), document_type: license.type },
      });
    }
    if (paused) await invalidateCacheNamespace(PROVIDER_PRICES_CACHE);
    const orgs = await this.organizationLicences(now, horizon);
    warned += orgs.warned;
    paused += orgs.paused;
    // Clinic and branch licences (clinic visits, C5).
    const clinics = await Container.get(ClinicService).processLicenceExpiry(
      now,
      DOCUMENT_EXPIRY_WARNING_DAYS,
    );
    return { warned: warned + clinics.warned, paused: paused + clinics.paused };
  }

  /**
   * Organizations' activity licences: the owner is told once within 30 days of the expiry; once expired
   * (and no newer valid one is approved) the organization is paused — no patient can find or book it —
   * until an admin approves a valid licence (`OrganizationAdminService.reviewDocument`).
   */
  private async organizationLicences(now: Date, horizon: Date) {
    let warned = 0;
    let paused = 0;
    const ownerOf = async (orgId: unknown) =>
      (await OrganizationModel.findById(orgId).select('ownerUserId').lean())?.ownerUserId;
    const expiring = await OrganizationDocumentModel.find({
      type: OrganizationDocumentType.ACTIVITY_LICENCE,
      expiresAt: { $gt: now, $lte: horizon },
      expiryNoticeAt: null,
    }).lean();
    for (const document of expiring) {
      const claimed = await OrganizationDocumentModel.updateOne(
        { _id: document._id, expiryNoticeAt: null },
        { expiryNoticeAt: now },
      );
      const owner = claimed.modifiedCount ? await ownerOf(document.organizationId) : null;
      if (!owner) continue;
      await this.notifications.notify([owner], {
        type: NotificationType.VERIFICATION_RESULT,
        template: 'org_licence_expiring',
        params: (lang) => ({ date: formatCairoDateTime(document.expiresAt!, lang) }),
        data: { document_id: String(document._id), document_type: document.type },
      });
      warned++;
    }
    const expired = await OrganizationDocumentModel.find({
      type: OrganizationDocumentType.ACTIVITY_LICENCE,
      expiresAt: { $lte: now },
    }).lean();
    for (const licence of expired) {
      const newer = await OrganizationDocumentModel.exists({
        organizationId: licence.organizationId,
        type: OrganizationDocumentType.ACTIVITY_LICENCE,
        status: DocumentReviewStatus.MATCHING,
        $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
      });
      if (newer) continue;
      const org = await OrganizationModel.findOneAndUpdate(
        { _id: licence.organizationId, licencePausedAt: null },
        { licencePausedAt: now },
      );
      if (!org) continue;
      paused++;
      await this.audit.log(
        { actorId: null },
        {
          action: 'organization.paused_licence_expired',
          entityType: 'organization',
          entityId: String(org._id),
        },
      );
      await this.notifications.notify([org.ownerUserId], {
        type: NotificationType.VERIFICATION_RESULT,
        template: 'org_licence_expired',
        data: { document_id: String(licence._id), document_type: licence.type },
      });
    }
    if (paused) await invalidateCacheNamespace(PROVIDER_PRICES_CACHE);
    return { warned, paused };
  }
}
