import { Container, Service } from 'typedi';
import { ServiceCategoryModel } from '../../database/models/catalog/service-category.model';
import { CatalogServiceModel } from '../../database/models/catalog/catalog-service.model';
import { ProviderProfileModel } from '../../database/models/provider/provider-profile.model';
import { VerificationStatus, type PricingUnit, type ProviderType } from '../../interfaces/enums';
import { cached } from '../../utils/cache/cache';
import { NotFoundError } from '../../utils/types-errors';
import { SettingsService } from '../settings/settings.service';

export const CATALOG_CACHE = 'catalog';
/** Starting prices depend on provider prices and status — invalidate on those changes. */
export const PROVIDER_PRICES_CACHE = 'provider-prices';
const CACHE_TTL_SECONDS = 600;
/** Video consultations (M2.6, deferred): hidden everywhere public while `features.video_consult` is off. */
export const VIDEO_CATEGORY_KEY = 'video_consultation';

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

/**
 * Public service catalog (spec §4.5, §7.3): active services in active categories only. The video
 * category is also left out while the video_consult flag is off, even if an admin activated it — so
 * its services can't be listed, searched, offered by providers or booked. The cache holds the rows
 * without that filter, so toggling the flag takes effect at once.
 */
@Service()
export class CatalogService {
  async activeCategories(): Promise<CategoryRow[]> {
    const [all, hidden] = await Promise.all([this.cachedCategories(), this.hiddenCategoryKeys()]);
    return all.filter((c) => !hidden.includes(c.key));
  }

  private async hiddenCategoryKeys() {
    const features = await Container.get(SettingsService).get('features');
    return features.video_consult ? [] : [VIDEO_CATEGORY_KEY];
  }

  private cachedCategories(): Promise<CategoryRow[]> {
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
      const categoryIds = (await this.cachedCategories()).map((c) => c.id);
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
    const visible = new Set((await this.activeCategories()).map((c) => c.id));
    return all.filter(
      (s) =>
        visible.has(s.categoryId) &&
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
