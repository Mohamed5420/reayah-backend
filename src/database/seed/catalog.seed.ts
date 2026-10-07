import { ServiceCategoryModel } from '../models/catalog/service-category.model';
import { CatalogServiceModel } from '../models/catalog/catalog-service.model';
import { SEED_CATEGORIES, SEED_NURSING_SERVICES } from './data/catalog.data';

/** Inserts missing categories/services only — same rules as seedLocations. */
export const seedCatalog = async () => {
  await ServiceCategoryModel.bulkWrite(
    SEED_CATEGORIES.map((category) => ({
      updateOne: {
        filter: { key: category.key },
        update: { $setOnInsert: { ...category, iconUrl: null, deletedAt: null } },
        upsert: true,
      },
    })),
  );

  const nursing = await ServiceCategoryModel.findOne({ key: 'nursing' })
    .setOptions({ withDeleted: true })
    .lean();
  if (!nursing) return;

  await CatalogServiceModel.bulkWrite(
    SEED_NURSING_SERVICES.map((service, index) => ({
      updateOne: {
        filter: { categoryId: nursing._id, nameAr: service.nameAr },
        update: {
          $setOnInsert: {
            ...service,
            categoryId: nursing._id,
            descriptionEn: null,
            minPrice: null,
            maxPrice: null,
            isActive: true,
            sortOrder: index + 1,
            deletedAt: null,
          },
        },
        upsert: true,
      },
    })),
  );
};
