import { Container, Service } from 'typedi';
import type { FilterQuery } from 'mongoose';
import { GovernorateModel } from '../../database/models/location/governorate.model';
import { AreaModel } from '../../database/models/location/area.model';
import type { IArea, IGovernorate } from '../../interfaces/ILocation';
import { invalidateCacheNamespace } from '../../utils/cache/cache';
import { escapeRegExp, normalizeSearchText } from '../../utils/text/arabic';
import { NotFoundError, ValidationError } from '../../utils/types-errors';
import type { Pagination } from '../../utils/response/pagination';
import { AuditService, applyPatch, type AuditContext } from '../audit/audit.service';
import { LOCATIONS_CACHE } from './location.service';

export type GovernorateInput = {
  nameAr: string;
  nameEn?: string | null;
  isActive?: boolean;
  sortOrder?: number;
};
export type AreaInput = {
  governorateId: string;
  nameAr: string;
  nameEn?: string | null;
  isActive?: boolean;
  maxTravelFee?: number | null;
};

const ARABIC = { locale: 'ar' };

/** Admin management of governorates and areas (spec §7.15 "Catalog & locations"). Every write is audited. */
@Service()
export class LocationAdminService {
  private readonly audit = Container.get(AuditService);

  async listGovernorates(filters: { isActive?: boolean; search?: string }, { skip, perPage }: Pagination) {
    const query: FilterQuery<IGovernorate> = {
      ...(filters.isActive !== undefined ? { isActive: filters.isActive } : {}),
      ...(filters.search ? { nameAr: { $regex: escapeRegExp(filters.search.trim()) } } : {}),
    };
    const [data, total] = await Promise.all([
      GovernorateModel.find(query)
        .collation(ARABIC)
        .sort({ sortOrder: 1, nameAr: 1 })
        .skip(skip)
        .limit(perPage)
        .lean(),
      GovernorateModel.countDocuments(query),
    ]);
    return { data, total };
  }

  async createGovernorate(input: GovernorateInput, context: AuditContext) {
    const governorate = await GovernorateModel.create(input);
    await this.afterWrite(context, 'governorate.create', 'governorate', String(governorate._id), { input });
    return governorate;
  }

  async updateGovernorate(id: string, patch: Partial<GovernorateInput>, context: AuditContext) {
    const governorate = await GovernorateModel.findById(id);
    if (!governorate) throw new NotFoundError('errors.governorate_not_found');
    const changes = applyPatch(governorate, patch);
    if (Object.keys(changes).length) {
      await governorate.save();
      await this.afterWrite(context, 'governorate.update', 'governorate', id, { changes });
    }
    return governorate;
  }

  async listAreas(
    filters: { governorateId?: string; isActive?: boolean; search?: string },
    { skip, perPage }: Pagination,
  ) {
    const query: FilterQuery<IArea> = {
      ...(filters.governorateId ? { governorateId: filters.governorateId } : {}),
      ...(filters.isActive !== undefined ? { isActive: filters.isActive } : {}),
      ...(filters.search
        ? { searchName: { $regex: escapeRegExp(normalizeSearchText(filters.search)) } }
        : {}),
    };
    const [data, total] = await Promise.all([
      AreaModel.find(query).collation(ARABIC).sort({ nameAr: 1 }).skip(skip).limit(perPage).lean(),
      AreaModel.countDocuments(query),
    ]);
    return { data, total };
  }

  async createArea(input: AreaInput, context: AuditContext) {
    await this.assertGovernorateExists(input.governorateId);
    const area = await AreaModel.create(input);
    await this.afterWrite(context, 'area.create', 'area', String(area._id), { input });
    return area;
  }

  /** Deactivating an area removes it from search and booking immediately. */
  async updateArea(id: string, patch: Partial<AreaInput>, context: AuditContext) {
    const area = await AreaModel.findById(id);
    if (!area) throw new NotFoundError('errors.area_not_found');
    if (patch.governorateId) await this.assertGovernorateExists(patch.governorateId);
    const changes = applyPatch(area, patch);
    if (Object.keys(changes).length) {
      await area.save();
      await this.afterWrite(context, 'area.update', 'area', id, { changes });
    }
    return area;
  }

  private async assertGovernorateExists(governorateId: string) {
    if (!(await GovernorateModel.exists({ _id: governorateId }))) {
      throw new ValidationError({ governorate_id: ['validation.not_found'] });
    }
  }

  private async afterWrite(
    context: AuditContext,
    action: string,
    entityType: string,
    entityId: string,
    metadata: Record<string, unknown>,
  ) {
    await this.audit.log(context, { action, entityType, entityId, metadata });
    await invalidateCacheNamespace(LOCATIONS_CACHE);
  }
}
