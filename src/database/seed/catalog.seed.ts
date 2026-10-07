import { ServiceCategoryModel } from '../models/catalog/service-category.model';
import { CatalogServiceModel } from '../models/catalog/catalog-service.model';
import { SEED_CATEGORIES, SEED_DOCTOR_SERVICES, SEED_NURSING_SERVICES } from './data/catalog.data';

/** Starter services per category key. */
const SEED_SERVICES_BY_CATEGORY = {
  nursing: SEED_NURSING_SERVICES,
  doctor_home_visit: SEED_DOCTOR_SERVICES,
};

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

  for (const [key, services] of Object.entries(SEED_SERVICES_BY_CATEGORY)) {
    const category = await ServiceCategoryModel.findOne({ key }).setOptions({ withDeleted: true }).lean();
    if (!category) continue;
    await CatalogServiceModel.bulkWrite(
      services.map((service, index) => ({
        updateOne: {
          filter: { categoryId: category._id, nameAr: service.nameAr },
          update: {
            $setOnInsert: {
              ...service,
              categoryId: category._id,
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
  }
};
