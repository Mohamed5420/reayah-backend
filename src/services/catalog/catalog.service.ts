import { Service } from 'typedi';
import { ServiceCategoryModel } from '../../database/models/catalog/service-category.model';
import { CatalogServiceModel } from '../../database/models/catalog/catalog-service.model';
import { ProviderProfileModel } from '../../database/models/provider/provider-profile.model';
import { VerificationStatus, type PricingUnit, type ProviderType } from '../../interfaces/enums';
import { cached } from '../../utils/cache/cache';
import { NotFoundError } from '../../utils/types-errors';

export const CATALOG_CACHE = 'catalog';
/** Starting prices depend on provider prices and status — invalidate on those changes. */
export const PROVIDER_PRICES_CACHE = 'provider-prices';
const CACHE_TTL_SECONDS = 600;

export type CategoryRow = {
  id: string;
  key: string;
  nameAr: string;
  nameEn: string | null;
  iconUrl: string | null;
};
export type ServiceRow = {
  id: string;
  categoryId: string;
  nameAr: string;
  nameEn: string | null;
  descriptionAr: string | null;
  descriptionEn: string | null;
  providerType: ProviderType;
  pricingUnit: PricingUnit;
  defaultDurationMinutes: number;
  minPrice: number | null;
  maxPrice: number | null;
};

/** Public service catalog (spec §4.5, §7.3): active services in active categories only. */
@Service()
export class CatalogService {
  activeCategories(): Promise<CategoryRow[]> {
    return cached(CATALOG_CACHE, 'categories', CACHE_TTL_SECONDS, async () => {
      const docs = await ServiceCategoryModel.find({ isActive: true }).sort({ sortOrder: 1 }).lean();
      return docs.map((c) => ({
        id: String(c._id),
        key: c.key,
        nameAr: c.nameAr,
        nameEn: c.nameEn,
        iconUrl: c.iconUrl,
      }));
    });
  }

  async activeServices(
    filters: { categoryId?: string; providerType?: ProviderType } = {},
  ): Promise<ServiceRow[]> {
    const all = await cached(CATALOG_CACHE, 'services', CACHE_TTL_SECONDS, async () => {
      const categoryIds = (await this.activeCategories()).map((c) => c.id);
      const docs = await CatalogServiceModel.find({ isActive: true, categoryId: { $in: categoryIds } })
        .sort({ sortOrder: 1, nameAr: 1 })
        .lean();
      return docs.map((s): ServiceRow => ({
        id: String(s._id),
        categoryId: String(s.categoryId),
        nameAr: s.nameAr,
        nameEn: s.nameEn,
        descriptionAr: s.descriptionAr,
        descriptionEn: s.descriptionEn,
        providerType: s.providerType,
        pricingUnit: s.pricingUnit,
        defaultDurationMinutes: s.defaultDurationMinutes,
        minPrice: s.minPrice,
        maxPrice: s.maxPrice,
      }));
    });
    return all.filter(
      (s) =>
        (!filters.categoryId || s.categoryId === filters.categoryId) &&
        (!filters.providerType || s.providerType === filters.providerType),
    );
  }

  /** 404 unless the service is active and its category is active. */
  async getActiveService(id: string): Promise<ServiceRow> {
    const service = (await this.activeServices()).find((s) => s.id === id);
    if (!service) throw new NotFoundError('errors.service_not_found');
    return service;
  }

  /**
   * `starting_price` per service id: the lowest active price among approved providers taking bookings.
   * Services nobody offers yet are absent. (Organizations' prices join in Phase 3.)
   */
  startingPrices(): Promise<Record<string, number>> {
    return cached(PROVIDER_PRICES_CACHE, 'starting', CACHE_TTL_SECONDS, async () => {
      const rows = await ProviderProfileModel.aggregate<{ _id: unknown; min: number }>([
        { $match: { verificationStatus: VerificationStatus.APPROVED, isAcceptingBookings: true } },
        { $unwind: '$services' },
        { $match: { 'services.isActive': true } },
        { $group: { _id: '$services.serviceId', min: { $min: '$services.price' } } },
      ]);
      return Object.fromEntries(rows.map((r) => [String(r._id), r.min]));
    });
  }
}
