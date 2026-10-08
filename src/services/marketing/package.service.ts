import { Container, Service } from 'typedi';
import { Types, type ClientSession, type FilterQuery } from 'mongoose';
import { PackageModel, PackageSubscriptionModel } from '../../database/models/marketing/marketing.models';
import { ProviderProfileModel } from '../../database/models/provider/provider-profile.model';
import { OrganizationModel } from '../../database/models/organization/organization.models';
import { OrgDiscoveryService } from '../organization/org-discovery.service';
import { PaymentModel } from '../../database/models/payment/payment.models';
import { VerificationStatus } from '../../interfaces/enums';
import {
  PackageSubscriptionStatus,
  perVisitValue,
  type IPackage,
  type IPackageSubscription,
} from '../../interfaces/IMarketing';
import { NotificationType } from '../../interfaces/INotification';
import { PaymentRecordStatus } from '../../interfaces/IPayment';
import { cairoDate } from '../../utils/time/cairo';
import { logger } from '../../utils/logger/winston';
import type { Pagination } from '../../utils/response/pagination';
import {
  ConflictError,
  NotFoundError,
  PackageExpiredError,
  PackageNoVisitsLeftError,
  ValidationError,
} from '../../utils/types-errors';
import { AuditService, applyPatch, type AuditContext } from '../audit/audit.service';
import { CatalogService } from '../catalog/catalog.service';
import { NotificationService } from '../notification/notification.service';
import { PatientProfileService } from '../patient/patient-profile.service';
import { SettingsService } from '../settings/settings.service';
import { offeredEntry } from '../catalog/visit-types';
import { BookingType } from '../../interfaces/IBooking';

const DAY_MS = 24 * 3600_000;

/**
 * Packages (spec §4.7, §7.9; M2.5). Platform packages are bought by card / wallet upfront (no cash):
 * the subscription waits in `pending_payment` until the gateway confirms, then runs `validity_days`.
 * Booking with a package covers the visit's subtotal; only providers whose own price is at or below
 * the package's per-visit value qualify, they earn their usual payout, and any difference stays with
 * the platform. A visit is reserved when booked, used on completion (decision 7) and given back if the
 * booking ends without a visit.
 */
@Service()
export class PackageService {
  private readonly settings = Container.get(SettingsService);
  private readonly catalog = Container.get(CatalogService);
  private readonly notifications = Container.get(NotificationService);

  async enabled() {
    return (await this.settings.get('features')).packages;
  }

  /** GET /packages: active packages for active services; with an area, only those someone there can serve. */
  async listAvailable(filters: { serviceId?: string; areaId?: string }) {
    if (!(await this.enabled())) return [];
    const services = new Map((await this.catalog.activeServices()).map((s) => [s.id, s]));
    const packages = await PackageModel.find({
      isActive: true,
      ...(filters.serviceId ? { serviceId: filters.serviceId } : {}),
    })
      .sort({ sortOrder: 1, price: 1 })
      .lean();
    const orgs = await this.approvedOrgs(packages);
    const rows = [];
    for (const pkg of packages) {
      const service = services.get(String(pkg.serviceId));
      if (!service) continue;
      // An organization's package shows only while the organization is approved.
      const organization = pkg.organizationId ? orgs.get(String(pkg.organizationId)) : null;
      if (pkg.organizationId && !organization) continue;
      if (filters.areaId && !(await this.servedIn(pkg, filters.areaId))) continue;
      rows.push({ pkg, service, organization: organization ?? null });
    }
    return rows;
  }

  async getAvailable(id: string) {
    const pkg =
      Types.ObjectId.isValid(id) && (await this.enabled())
        ? await PackageModel.findOne({ _id: id, isActive: true }).lean()
        : null;
    const service = pkg
      ? (await this.catalog.activeServices()).find((s) => s.id === String(pkg.serviceId))
      : undefined;
    const organization = pkg?.organizationId
      ? (await this.approvedOrgs([pkg])).get(String(pkg.organizationId))
      : null;
    if (!pkg || !service || (pkg.organizationId && !organization)) {
      throw new NotFoundError('errors.package_not_found');
    }
    return { pkg, service, organization: organization ?? null };
  }

  /** Names of the approved organizations among these packages' owners. */
  private async approvedOrgs(packages: Array<Pick<IPackage, 'organizationId'>>) {
    const ids = packages.flatMap((p) => (p.organizationId ? [p.organizationId] : []));
    if (!ids.length) return new Map<string, { id: string; name: string }>();
    const orgs = await OrganizationModel.find({
      _id: { $in: ids },
      verificationStatus: VerificationStatus.APPROVED,
    })
      .select('name')
      .lean();
    return new Map(orgs.map((o) => [String(o._id), { id: String(o._id), name: o.name }]));
  }

  /** POST /packages/{id}/subscribe — creates the unpaid subscription; the caller starts the checkout. */
  async createSubscription(userId: string, packageId: string, patientProfileId: string) {
    if (!(await this.enabled())) throw new ConflictError('errors.packages_unavailable');
    const { pkg } = await this.getAvailable(packageId);
    const profile = await Container.get(PatientProfileService).getOwned(userId, patientProfileId);
    const subscription = await PackageSubscriptionModel.create({
      packageId: pkg._id,
      patientUserId: userId,
      patientProfileId: profile._id,
      package: {
        nameAr: pkg.nameAr,
        nameEn: pkg.nameEn,
        organizationId: pkg.organizationId ?? null,
        serviceId: pkg.serviceId,
        visitsCount: pkg.visitsCount,
        validityDays: pkg.validityDays,
        price: pkg.price,
        perVisitValue: perVisitValue(pkg),
      },
      visitsRemaining: pkg.visitsCount,
    });
    return subscription.toObject();
  }

  async mine(userId: string, pagination: Pagination) {
    const query = {
      patientUserId: new Types.ObjectId(userId),
      status: { $ne: PackageSubscriptionStatus.CANCELLED },
    };
    const [data, total] = await Promise.all([
      PackageSubscriptionModel.find(query)
        .sort({ createdAt: -1 })
        .skip(pagination.skip)
        .limit(pagination.perPage)
        .lean(),
      PackageSubscriptionModel.countDocuments(query),
    ]);
    return { data, total };
  }

  getOwned(userId: string, subscriptionId: string) {
    return Types.ObjectId.isValid(subscriptionId)
      ? PackageSubscriptionModel.findOne({ _id: subscriptionId, patientUserId: userId }).lean()
      : Promise.resolve(null);
  }

  /** For the home screen: the active package that expires first. */
  activeForHome(userId: string) {
    return PackageSubscriptionModel.findOne({
      patientUserId: userId,
      status: PackageSubscriptionStatus.ACTIVE,
      expiresAt: { $gt: new Date() },
    })
      .sort({ expiresAt: 1 })
      .lean();
  }

  /**
   * Whether this booking can use the subscription (quote, booking, reschedule). `rescheduling` skips
   * the free-visit check: the booking already holds its visit.
   */
  async assertUsable(
    userId: string,
    subscriptionId: string,
    booking: {
      patientProfileId: string;
      serviceId: string;
      quantity: number;
      scheduledStart: Date;
      providerPrice: number;
      /** The organization being booked, if any. */
      organizationId?: string | null;
    },
    rescheduling = false,
  ) {
    const sub = await this.getOwned(userId, subscriptionId);
    if (
      !sub ||
      sub.status === PackageSubscriptionStatus.PENDING_PAYMENT ||
      sub.status === PackageSubscriptionStatus.CANCELLED
    ) {
      throw new NotFoundError('errors.package_subscription_not_found');
    }
    if (sub.status === PackageSubscriptionStatus.EXPIRED || !sub.expiresAt || sub.expiresAt <= new Date()) {
      throw new PackageExpiredError();
    }
    if (booking.scheduledStart >= sub.expiresAt) throw new PackageExpiredError();
    if (
      sub.status === PackageSubscriptionStatus.USED_UP ||
      (!rescheduling && sub.visitsRemaining - sub.visitsReserved <= 0)
    ) {
      throw new PackageNoVisitsLeftError();
    }
    if (String(sub.patientProfileId) !== booking.patientProfileId) {
      throw new ValidationError({ package_subscription_id: ['validation.package_other_profile'] });
    }
    if (String(sub.package.serviceId) !== booking.serviceId) {
      throw new ValidationError({ package_subscription_id: ['validation.package_other_service'] });
    }
    if (booking.quantity !== 1) throw new ValidationError({ quantity: ['validation.package_one_visit'] });
    if (sub.package.organizationId) {
      // An organization's package: that organization only; the visit is priced at the per-visit value.
      if (String(sub.package.organizationId) !== String(booking.organizationId ?? '')) {
        throw new ValidationError({ package_subscription_id: ['validation.package_other_organization'] });
      }
      return sub;
    }
    if (booking.providerPrice > sub.package.perVisitValue) {
      throw new ValidationError({ provider_id: ['validation.provider_above_package_price'] });
    }
    return sub;
  }

  /** Holds one visit for a booking being created (inside its transaction). */
  async reserve(session: ClientSession, subscriptionId: Types.ObjectId | string, scheduledStart: Date) {
    const sub = await PackageSubscriptionModel.findOneAndUpdate(
      {
        _id: subscriptionId,
        status: PackageSubscriptionStatus.ACTIVE,
        expiresAt: { $gt: scheduledStart },
        $expr: { $lt: ['$visitsReserved', '$visitsRemaining'] },
      },
      { $inc: { visitsReserved: 1 } },
      { new: true, session },
    );
    if (!sub) throw new PackageNoVisitsLeftError();
  }

  /** The booking ended without a visit: its visit is free again. */
  async release(session: ClientSession, subscriptionId: Types.ObjectId) {
    await PackageSubscriptionModel.updateOne(
      { _id: subscriptionId, visitsReserved: { $gt: 0 } },
      { $inc: { visitsReserved: -1 } },
      { session },
    );
  }

  /** The visit was completed: it is used (decision 7). The last one marks the package used up. */
  async consume(session: ClientSession, subscriptionId: Types.ObjectId) {
    const sub = await PackageSubscriptionModel.findOneAndUpdate(
      { _id: subscriptionId, visitsReserved: { $gt: 0 }, visitsRemaining: { $gt: 0 } },
      { $inc: { visitsReserved: -1, visitsRemaining: -1 } },
      { new: true, session },
    );
    if (sub && sub.visitsRemaining === 0 && sub.status === PackageSubscriptionStatus.ACTIVE) {
      await PackageSubscriptionModel.updateOne(
        { _id: sub._id },
        { status: PackageSubscriptionStatus.USED_UP },
        { session },
      );
    }
  }

  /** Paid: the subscription starts now. Returns null if it was no longer waiting (the caller refunds). */
  async activate(
    session: ClientSession,
    subscriptionId: Types.ObjectId,
    paymentId: Types.ObjectId,
    now = new Date(),
  ) {
    const sub = await PackageSubscriptionModel.findOne({ _id: subscriptionId }).session(session).lean();
    if (!sub) return null;
    return PackageSubscriptionModel.findOneAndUpdate(
      { _id: subscriptionId, status: PackageSubscriptionStatus.PENDING_PAYMENT },
      {
        status: PackageSubscriptionStatus.ACTIVE,
        paymentId,
        startsAt: now,
        expiresAt: new Date(now.getTime() + sub.package.validityDays * DAY_MS),
      },
      { new: true, session, lean: true },
    );
  }

  /** Unpaid purchases older than the payment window are cancelled (run with the payment sweep). */
  async cancelUnpaid(now = new Date()) {
    const windowMinutes = await this.settings.get('card_payment_window_minutes');
    const cutoff = new Date(now.getTime() - windowMinutes * 60_000);
    const stale = await PackageSubscriptionModel.find({
      status: PackageSubscriptionStatus.PENDING_PAYMENT,
      createdAt: { $lte: cutoff },
    })
      .select('_id')
      .lean();
    for (const { _id } of stale) {
      const cancelled = await PackageSubscriptionModel.updateOne(
        { _id, status: PackageSubscriptionStatus.PENDING_PAYMENT },
        { status: PackageSubscriptionStatus.CANCELLED },
      );
      if (cancelled.modifiedCount) {
        await PaymentModel.updateMany(
          { packageSubscriptionId: _id, status: PaymentRecordStatus.PENDING },
          { status: PaymentRecordStatus.EXPIRED },
        );
      }
    }
    return stale.length;
  }

  /** When an unpaid purchase stops accepting payment. */
  async paymentDeadline(sub: Pick<IPackageSubscription, 'createdAt'>) {
    const windowMinutes = await this.settings.get('card_payment_window_minutes');
    return new Date(sub.createdAt.getTime() + windowMinutes * 60_000);
  }

  /**
   * Hourly (PACKAGE_EXPIRY): ends packages past their date, warns `package_expiry_notice_days` before
   * the end (once) and when one visit is left (once).
   */
  async processDue(now = new Date()) {
    const expired = await PackageSubscriptionModel.find({
      status: PackageSubscriptionStatus.ACTIVE,
      expiresAt: { $lte: now },
    }).lean();
    for (const sub of expired) {
      const updated = await PackageSubscriptionModel.updateOne(
        { _id: sub._id, status: PackageSubscriptionStatus.ACTIVE },
        { status: PackageSubscriptionStatus.EXPIRED },
      );
      if (updated.modifiedCount) await this.notify(sub, 'package_expired');
    }

    const noticeDays = await this.settings.get('package_expiry_notice_days');
    if (noticeDays > 0) {
      const soon = await PackageSubscriptionModel.find({
        status: PackageSubscriptionStatus.ACTIVE,
        expiresAt: { $gt: now, $lte: new Date(now.getTime() + noticeDays * DAY_MS) },
        expiryNoticeAt: null,
        $expr: { $gt: ['$visitsRemaining', 0] },
      }).lean();
      for (const sub of soon) {
        const claimed = await PackageSubscriptionModel.updateOne(
          { _id: sub._id, expiryNoticeAt: null },
          { expiryNoticeAt: now },
        );
        if (claimed.modifiedCount) await this.notify(sub, 'package_expiring');
      }
    }

    const low = await PackageSubscriptionModel.find({
      status: PackageSubscriptionStatus.ACTIVE,
      visitsRemaining: 1,
      lowVisitsNoticeAt: null,
    }).lean();
    for (const sub of low) await this.noticeLowVisits(sub, now);
    return { expired: expired.length };
  }

  /** "One visit left" — after the second-to-last visit is completed (also caught by the hourly job). */
  async noticeLowVisits(sub: IPackageSubscription, now = new Date()) {
    if (sub.visitsRemaining !== 1 || sub.lowVisitsNoticeAt) return;
    const claimed = await PackageSubscriptionModel.updateOne(
      { _id: sub._id, lowVisitsNoticeAt: null },
      { lowVisitsNoticeAt: now },
    );
    if (claimed.modifiedCount) await this.notify(sub, 'package_low_visits');
  }

  notifyActivated(sub: IPackageSubscription) {
    return this.notify(sub, 'package_activated');
  }

  private async notify(
    sub: IPackageSubscription,
    template: 'package_expired' | 'package_expiring' | 'package_low_visits' | 'package_activated',
  ) {
    await this.notifications
      .notify([sub.patientUserId], {
        type: NotificationType.PACKAGE_EXPIRY,
        template,
        params: (lang) => ({
          name: (lang === 'en' && sub.package.nameEn) || sub.package.nameAr,
          visits: sub.visitsRemaining,
          date: sub.expiresAt ? cairoDate(sub.expiresAt) : '',
        }),
        data: { package_subscription_id: String(sub._id) },
      })
      .catch((err: unknown) => logger.error(`Package notice ${template} failed for ${String(sub._id)}`, err));
  }

  /** At least one approved, accepting provider covers the area and offers the service at ≤ the per-visit value. */
  private async servedIn(pkg: IPackage, areaId: string) {
    if (!Types.ObjectId.isValid(areaId)) return false;
    const orgs = Container.get(OrgDiscoveryService);
    // An organization's package: that organization has a staff member for the area and service.
    if (pkg.organizationId) {
      return (
        (await orgs.eligibleStaff(pkg.organizationId, { serviceId: String(pkg.serviceId), areaId })).length >
        0
      );
    }
    const area = new Types.ObjectId(areaId);
    const independent = await ProviderProfileModel.exists({
      verificationStatus: VerificationStatus.APPROVED,
      isAcceptingBookings: true,
      organizationId: null,
      'serviceAreas.areaId': area,
      services: {
        $elemMatch: { serviceId: pkg.serviceId, isActive: true, price: { $lte: perVisitValue(pkg) } },
      },
    });
    if (independent) return true;
    // Or an organization in the area at or below the per-visit value, with someone to send.
    const candidates = await OrganizationModel.find({
      verificationStatus: VerificationStatus.APPROVED,
      serviceAreas: { $elemMatch: { areaId: area, isActive: true } },
      services: {
        $elemMatch: { serviceId: pkg.serviceId, isActive: true, price: { $lte: perVisitValue(pkg) } },
      },
    })
      .select('_id')
      .lean();
    for (const org of candidates) {
      if ((await orgs.eligibleStaff(org._id, { serviceId: String(pkg.serviceId), areaId })).length)
        return true;
    }
    return false;
  }
}

export type PackageInput = {
  nameAr: string;
  nameEn?: string | null;
  descriptionAr?: string | null;
  descriptionEn?: string | null;
  serviceId: string;
  visitsCount: number;
  validityDays: number;
  price: number;
  isActive?: boolean;
  sortOrder?: number;
};

/** Admin: /admin/packages (platform packages). Changes never touch subscriptions already sold (snapshots). */
@Service()
export class PackageAdminService {
  private readonly audit = Container.get(AuditService);

  async list(filters: { isActive?: boolean }, { skip, perPage }: Pagination) {
    const query: FilterQuery<IPackage> = {
      organizationId: null,
      ...(filters.isActive !== undefined ? { isActive: filters.isActive } : {}),
    };
    const [data, total] = await Promise.all([
      PackageModel.find(query).sort({ sortOrder: 1, createdAt: -1 }).skip(skip).limit(perPage).lean(),
      PackageModel.countDocuments(query),
    ]);
    const sold = await PackageSubscriptionModel.aggregate<{ _id: Types.ObjectId; count: number }>([
      {
        $match: {
          packageId: { $in: data.map((p) => p._id) },
          status: { $nin: [PackageSubscriptionStatus.PENDING_PAYMENT, PackageSubscriptionStatus.CANCELLED] },
        },
      },
      { $group: { _id: '$packageId', count: { $sum: 1 } } },
    ]);
    const soldBy = new Map(sold.map((s) => [String(s._id), s.count]));
    return { data: data.map((p) => ({ ...p, soldCount: soldBy.get(String(p._id)) ?? 0 })), total };
  }

  async create(input: PackageInput, context: AuditContext) {
    await this.assertService(input.serviceId);
    const pkg = await PackageModel.create({ ...input, organizationId: null });
    await this.audit.log(context, {
      action: 'package.create',
      entityType: 'package',
      entityId: String(pkg._id),
      metadata: { input },
    });
    return { ...pkg.toObject(), soldCount: 0 };
  }

  async update(id: string, patch: Partial<PackageInput>, context: AuditContext) {
    const pkg = Types.ObjectId.isValid(id)
      ? await PackageModel.findOne({ _id: id, organizationId: null })
      : null;
    if (!pkg) throw new NotFoundError('errors.package_not_found');
    if (patch.serviceId) await this.assertService(patch.serviceId);
    const changes = applyPatch(pkg, patch);
    if (Object.keys(changes).length) {
      await pkg.save();
      await this.audit.log(context, {
        action: 'package.update',
        entityType: 'package',
        entityId: id,
        metadata: { changes },
      });
    }
    const soldCount = await PackageSubscriptionModel.countDocuments({
      packageId: pkg._id,
      status: { $nin: [PackageSubscriptionStatus.PENDING_PAYMENT, PackageSubscriptionStatus.CANCELLED] },
    });
    return { ...pkg.toObject(), soldCount };
  }

  private async assertService(serviceId: string) {
    const exists = (await Container.get(CatalogService).activeServices()).some((s) => s.id === serviceId);
    if (!exists) throw new ValidationError({ service_id: ['validation.invalid_value'] });
  }
}

/**
 * An organization's own packages (spec §7.11 `/org/packages`; M3.4): for services it offers. Sold like
 * platform packages (card / wallet upfront to the platform); each completed visit earns the organization
 * the per-visit value minus its commission (decision M3.4).
 */
@Service()
export class OrgPackageService {
  list(orgId: Types.ObjectId) {
    return PackageModel.find({ organizationId: orgId }).sort({ sortOrder: 1, createdAt: -1 }).lean();
  }

  async create(
    org: { _id: Types.ObjectId; services: Array<{ serviceId: Types.ObjectId; isActive: boolean }> },
    input: PackageInput,
  ) {
    this.assertOffered(org, input.serviceId);
    const pkg = await PackageModel.create({ ...input, organizationId: org._id });
    return pkg.toObject();
  }

  async update(
    org: { _id: Types.ObjectId; services: Array<{ serviceId: Types.ObjectId; isActive: boolean }> },
    id: string,
    patch: Partial<PackageInput>,
  ) {
    const pkg = Types.ObjectId.isValid(id)
      ? await PackageModel.findOne({ _id: id, organizationId: org._id })
      : null;
    if (!pkg) throw new NotFoundError('errors.package_not_found');
    if (patch.serviceId) this.assertOffered(org, patch.serviceId);
    applyPatch(pkg, patch);
    await pkg.save();
    return pkg.toObject();
  }

  /** Spec: DELETE deactivates (packages already sold keep working). */
  deactivate(
    org: { _id: Types.ObjectId; services: Array<{ serviceId: Types.ObjectId; isActive: boolean }> },
    id: string,
  ) {
    return this.update(org, id, { isActive: false });
  }

  private assertOffered(
    org: { services: Array<{ serviceId: Types.ObjectId; isActive: boolean; visitType?: BookingType }> },
    serviceId: string,
  ) {
    // Packages are home visits until C5 adds a visit type to packages.
    if (!offeredEntry(org.services, serviceId, BookingType.HOME_VISIT)) {
      throw new ValidationError({ service_id: ['validation.service_not_offered_by_org'] });
    }
  }
}
