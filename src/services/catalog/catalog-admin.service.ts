import { Container, Service } from 'typedi';
import type { FilterQuery } from 'mongoose';
import { ServiceCategoryModel } from '../../database/models/catalog/service-category.model';
import { CatalogServiceModel } from '../../database/models/catalog/catalog-service.model';
import type { ICatalogService } from '../../interfaces/ICatalog';
import { ProviderType, type PricingUnit } from '../../interfaces/enums';
import { invalidateCacheNamespace } from '../../utils/cache/cache';
import { escapeRegExp } from '../../utils/text/arabic';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/types-errors';
import type { Pagination } from '../../utils/response/pagination';
import { AuditService, applyPatch, type AuditContext } from '../audit/audit.service';
import { CATALOG_CACHE } from './catalog.service';
import { BookingType } from '../../interfaces/IBooking';

export type CategoryInput = {
  key: string;
  nameAr: string;
  nameEn?: string | null;
  iconUrl?: string | null;
  isActive?: boolean;
  sortOrder?: number;
};

export type ServiceInput = {
  categoryId: string;
  nameAr: string;
  nameEn?: string | null;
  descriptionAr?: string | null;
  descriptionEn?: string | null;
  providerType: ProviderType;
  pricingUnit: PricingUnit;
  defaultDurationMinutes: number;
  minPrice?: number | null;
  maxPrice?: number | null;
  visitTypes?: BookingType[];
  clinicMinPrice?: number | null;
  clinicMaxPrice?: number | null;
  isActive?: boolean;
  sortOrder?: number;
};

/** Admin management of categories and services (spec §7.15 "Catalog & locations"). Every write is audited. */
@Service()
export class CatalogAdminService {
  private readonly audit = Container.get(AuditService);

  listCategories() {
    return ServiceCategoryModel.find().sort({ sortOrder: 1 }).lean();
  }

  async createCategory(input: CategoryInput, context: AuditContext) {
    const category = await ServiceCategoryModel.create(input);
    await this.afterWrite(context, 'service_category.create', 'service_category', String(category._id), {
      input,
    });
    return category;
  }

  async updateCategory(id: string, patch: Partial<CategoryInput>, context: AuditContext) {
    const category = await ServiceCategoryModel.findById(id);
    if (!category) throw new NotFoundError('errors.category_not_found');
    const changes = applyPatch(category, patch);
    if (Object.keys(changes).length) {
      await category.save();
      await this.afterWrite(context, 'service_category.update', 'service_category', id, { changes });
    }
    return category;
  }

  /** Soft delete. Refused while any service (active or not) still belongs to the category. */
  async deleteCategory(id: string, context: AuditContext) {
    const category = await ServiceCategoryModel.findById(id);
    if (!category) throw new NotFoundError('errors.category_not_found');
    if (await CatalogServiceModel.exists({ categoryId: id })) {
      throw new ConflictError('errors.category_has_services');
    }
    await category.softDelete();
    await this.afterWrite(context, 'service_category.delete', 'service_category', id, {});
  }

  async listServices(
    filters: { categoryId?: string; isActive?: boolean; providerType?: ProviderType; search?: string },
    { skip, perPage }: Pagination,
  ) {
    const query: FilterQuery<ICatalogService> = {
      ...(filters.categoryId ? { categoryId: filters.categoryId } : {}),
      ...(filters.isActive !== undefined ? { isActive: filters.isActive } : {}),
      ...(filters.providerType ? { providerType: filters.providerType } : {}),
      ...(filters.search ? { nameAr: { $regex: escapeRegExp(filters.search.trim()) } } : {}),
    };
    const [data, total] = await Promise.all([
      CatalogServiceModel.find(query).sort({ sortOrder: 1, nameAr: 1 }).skip(skip).limit(perPage).lean(),
      CatalogServiceModel.countDocuments(query),
    ]);
    return { data, total };
  }

  async createService(input: ServiceInput, context: AuditContext) {
    await this.assertCategoryExists(input.categoryId);
    assertPriceBounds(input.minPrice ?? null, input.maxPrice ?? null);
    assertPriceBounds(input.clinicMinPrice ?? null, input.clinicMaxPrice ?? null, 'clinic_max_price');
    assertVisitTypes(input.providerType, input.visitTypes ?? [BookingType.HOME_VISIT]);
    const service = await CatalogServiceModel.create(input);
    await this.afterWrite(context, 'service.create', 'service', String(service._id), { input });
    return service;
  }

  async updateService(id: string, patch: Partial<ServiceInput>, context: AuditContext) {
    const service = await CatalogServiceModel.findById(id);
    if (!service) throw new NotFoundError('errors.service_not_found');
    if (patch.categoryId) await this.assertCategoryExists(patch.categoryId);
    const changes = applyPatch(service, patch);
    assertPriceBounds(service.minPrice, service.maxPrice); // checks the merged result
    assertPriceBounds(service.clinicMinPrice ?? null, service.clinicMaxPrice ?? null, 'clinic_max_price');
    assertVisitTypes(service.providerType, service.visitTypes);
    if (Object.keys(changes).length) {
      await service.save();
      await this.afterWrite(context, 'service.update', 'service', id, { changes });
    }
    return service;
  }

  /** Spec: DELETE deactivates (providers' history keeps pointing at the service). */
  async deactivateService(id: string, context: AuditContext) {
    await this.updateService(id, { isActive: false }, context);
  }

  private async assertCategoryExists(categoryId: string) {
    if (!(await ServiceCategoryModel.exists({ _id: categoryId }))) {
      throw new ValidationError({ category_id: ['validation.not_found'] });
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
    await invalidateCacheNamespace(CATALOG_CACHE);
  }
}

const assertPriceBounds = (minPrice: number | null, maxPrice: number | null, field = 'max_price') => {
  if (minPrice !== null && maxPrice !== null && maxPrice < minPrice) {
    throw new ValidationError({ [field]: ['validation.max_below_min'] });
  }
};

/** Clinic visits are for doctors only (nurses stay home visits, decision C1). */
const assertVisitTypes = (providerType: ProviderType, visitTypes: BookingType[]) => {
  if (visitTypes.includes(BookingType.CLINIC_VISIT) && providerType !== ProviderType.DOCTOR) {
    throw new ValidationError({ visit_types: ['validation.clinic_doctors_only'] });
  }
};
