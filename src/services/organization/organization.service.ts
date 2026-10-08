import { Container, Service } from 'typedi';
import { Types, type HydratedDocument } from 'mongoose';
import {
  OrganizationDocumentModel,
  OrganizationModel,
} from '../../database/models/organization/organization.models';
import { ProviderProfileModel } from '../../database/models/provider/provider-profile.model';
import { VerificationStatus } from '../../interfaces/enums';
import { DocumentReviewStatus } from '../../interfaces/IProvider';
import {
  REQUIRED_ORGANIZATION_DOCUMENTS,
  type IOrganization,
  type OrganizationChecklist,
  type OrganizationType,
} from '../../interfaces/IOrganization';
import { logger } from '../../utils/logger/winston';
import { ConflictError, NotFoundError, ValidationError, type ErrorFields } from '../../utils/types-errors';
import { CatalogService } from '../catalog/catalog.service';
import { LocationService } from '../location/location.service';
import { StorageService } from '../storage/storage.service';
import { EDITABLE_STATUSES } from '../provider/provider-profile.service';

export type OrganizationDoc = HydratedDocument<IOrganization>;

export type OrganizationInput = {
  name: string;
  type: OrganizationType;
  commercialRegisterNo: string;
  taxId: string;
  description?: string | null;
  phone?: string | null;
  addressText?: string | null;
};

/** Identity fields: editable only before approval (as for providers), so what was verified stays put. */
const IDENTITY_FIELDS = ['name', 'type', 'commercialRegisterNo', 'taxId'] as const;

/** Checklist item → field name + message reported when it's missing at submission. */
const MISSING_ITEM_FIELDS = {
  infoCompleted: ['organization', 'validation.onboarding_org_info'],
  documentsUploaded: ['documents', 'validation.onboarding_documents'],
  areasSelected: ['service_areas', 'validation.onboarding_areas'],
  servicesSet: ['services', 'validation.onboarding_services'],
} as const;

const addError = (fields: ErrorFields, key: string, message: string) => {
  (fields[key] ??= []).push(message);
};

/**
 * The owner's organization (spec §7.11 "Organization setup", M3.1): one per owner account. Setup =
 * info, commercial register + tax card, service areas with travel fees, services with prices; then the
 * owner submits it to the same admin verification queue providers use. Until approved it can't appear
 * in search or receive bookings (spec §6 rule 7).
 */
@Service()
export class OrganizationService {
  private readonly locations = Container.get(LocationService);
  private readonly catalog = Container.get(CatalogService);
  private readonly storage = Container.get(StorageService);

  /** POST /org. A second organization for the same owner, or a commercial register already used → 409. */
  async create(userId: string, input: OrganizationInput) {
    if (await OrganizationModel.exists({ ownerUserId: userId })) {
      throw new ConflictError('errors.organization_exists');
    }
    return OrganizationModel.create({ ...input, ownerUserId: userId });
  }

  async getOwn(userId: string) {
    const org = await OrganizationModel.findOne({ ownerUserId: userId });
    if (!org) throw new NotFoundError('errors.organization_not_found');
    return org;
  }

  findOwn(userId: string | Types.ObjectId) {
    return OrganizationModel.findOne({ ownerUserId: userId }).lean();
  }

  async update(userId: string, patch: Partial<OrganizationInput>) {
    const org = await this.getOwn(userId);
    const touchesIdentity = IDENTITY_FIELDS.some(
      (f) => patch[f] !== undefined && String(patch[f]) !== String(org.get(f)),
    );
    if (touchesIdentity && !EDITABLE_STATUSES.includes(org.verificationStatus)) {
      throw new ConflictError('errors.organization_fields_locked');
    }
    for (const [key, value] of Object.entries(patch)) if (value !== undefined) org.set(key, value);
    await org.save();
    return org;
  }

  /** POST /org/logo: stores the (already type-checked) image and replaces the previous one. */
  async setLogo(userId: string, file: { buffer: Buffer; mimetype: string }) {
    const org = await this.getOwn(userId);
    const previous = org.logoKey;
    org.logoKey = await this.storage.put(`org-logos/${String(org._id)}`, file.buffer, file.mimetype);
    await org.save();
    if (previous) {
      await this.storage
        .delete(previous)
        .catch((err: unknown) => logger.warn(`Failed to delete old logo ${previous}`, err));
    }
    return org;
  }

  logoUrl(org: Pick<IOrganization, 'logoKey'>) {
    return org.logoKey ? this.storage.signedUrl(org.logoKey) : Promise.resolve(null);
  }

  /** Areas must be bookable; travel fees can't exceed the area's admin cap (spec §4.2 `max_travel_fee`). */
  async replaceServiceAreas(
    org: OrganizationDoc,
    areas: Array<{ areaId: string; travelFee: number; isActive: boolean }>,
  ) {
    const fields: ErrorFields = {};
    const seen = new Set<string>();
    const found = await Promise.all(areas.map((a) => this.locations.findBookableArea(a.areaId)));
    for (const [i, { areaId, travelFee }] of areas.entries()) {
      if (seen.has(areaId)) addError(fields, `areas.${i}.area_id`, 'validation.duplicate');
      seen.add(areaId);
      const area = found[i];
      if (!area) addError(fields, `areas.${i}.area_id`, 'validation.area_unavailable');
      else if (area.maxTravelFee !== null && travelFee > area.maxTravelFee) {
        addError(fields, `areas.${i}.travel_fee`, 'validation.travel_fee_above_cap');
      }
    }
    if (Object.keys(fields).length) throw new ValidationError(fields);
    org.set(
      'serviceAreas',
      areas.map((a) => ({
        areaId: new Types.ObjectId(a.areaId),
        travelFee: a.travelFee,
        isActive: a.isActive,
      })),
    );
    await org.save();
    return org;
  }

  /**
   * Services must be active and priced within the admin bounds. An organization can offer nurse and
   * doctor services alike (its staff do the visits).
   */
  async replaceServices(
    org: OrganizationDoc,
    services: Array<{ serviceId: string; price: number; isActive: boolean }>,
  ) {
    const catalog = new Map((await this.catalog.activeServices()).map((s) => [s.id, s]));
    const fields: ErrorFields = {};
    const seen = new Set<string>();
    for (const [i, { serviceId, price }] of services.entries()) {
      if (seen.has(serviceId)) addError(fields, `services.${i}.service_id`, 'validation.duplicate');
      seen.add(serviceId);
      const service = catalog.get(serviceId);
      if (!service) addError(fields, `services.${i}.service_id`, 'validation.service_unavailable');
      else if (
        (service.minPrice !== null && price < service.minPrice) ||
        (service.maxPrice !== null && price > service.maxPrice)
      ) {
        addError(fields, `services.${i}.price`, 'validation.price_out_of_range');
      }
    }
    if (Object.keys(fields).length) throw new ValidationError(fields);
    org.set(
      'services',
      services.map((s) => ({
        serviceId: new Types.ObjectId(s.serviceId),
        price: s.price,
        isActive: s.isActive,
      })),
    );
    await org.save();
    return org;
  }

  /**
   * Team size per area (spec §4.4: computed, not stored) = approved staff of this organization who
   * cover the area and take bookings. Staff arrive in M3.2, so it is 0 until then.
   */
  async teamSizes(org: Pick<IOrganization, '_id'>) {
    const rows = await ProviderProfileModel.aggregate<{ _id: Types.ObjectId; count: number }>([
      {
        $match: {
          organizationId: org._id,
          verificationStatus: VerificationStatus.APPROVED,
          isAcceptingBookings: true,
          deletedAt: null,
        },
      },
      { $unwind: '$serviceAreas' },
      { $group: { _id: '$serviceAreas.areaId', count: { $sum: 1 } } },
    ]);
    return new Map(rows.map((r) => [String(r._id), r.count]));
  }

  async checklist(org: IOrganization): Promise<OrganizationChecklist> {
    const documents = await OrganizationDocumentModel.find({ organizationId: org._id }).lean();
    const usable = new Set(
      documents.filter((d) => d.status !== DocumentReviewStatus.NOT_MATCHING).map((d) => d.type),
    );
    const active = new Set((await this.catalog.activeServices()).map((s) => s.id));
    const items = {
      infoCompleted: Boolean(org.name && org.type && org.commercialRegisterNo && org.taxId),
      documentsUploaded: REQUIRED_ORGANIZATION_DOCUMENTS.every((type) => usable.has(type)),
      areasSelected: org.serviceAreas.some((a) => a.isActive),
      servicesSet: org.services.some((s) => s.isActive && active.has(String(s.serviceId))),
    };
    return {
      ...items,
      canSubmit: EDITABLE_STATUSES.includes(org.verificationStatus) && Object.values(items).every(Boolean),
    };
  }

  /** POST /org/submit-verification — 422 with one field per missing item. */
  async submit(userId: string) {
    const org = await this.getOwn(userId);
    if (!EDITABLE_STATUSES.includes(org.verificationStatus)) {
      throw new ConflictError('errors.verification_not_allowed');
    }
    const checklist = await this.checklist(org);
    const fields: ErrorFields = {};
    for (const [item, [field, message]] of Object.entries(MISSING_ITEM_FIELDS)) {
      if (!checklist[item as keyof typeof MISSING_ITEM_FIELDS]) fields[field] = [message];
    }
    if (Object.keys(fields).length) throw new ValidationError(fields);
    Object.assign(org, {
      verificationStatus: VerificationStatus.PENDING,
      submittedAt: new Date(),
      rejectionReason: null,
      adminMessage: null,
    });
    await org.save();
    return org;
  }
}
