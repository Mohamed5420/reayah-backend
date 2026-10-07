import { GovernorateModel } from '../models/location/governorate.model';
import { AreaModel, buildAreaSearchName } from '../models/location/area.model';
import { SEED_GOVERNORATES } from './data/locations.data';

/**
 * Inserts missing governorates/areas only (`$setOnInsert`), so admin edits are never overwritten.
 * bulkWrite skips query middleware, so the filters also match soft-deleted records — a governorate or
 * area an admin deleted is not re-created.
 */
export const seedLocations = async () => {
  await GovernorateModel.bulkWrite(
    SEED_GOVERNORATES.map(({ nameAr, nameEn, sortOrder }) => ({
      updateOne: {
        filter: { nameAr },
        update: { $setOnInsert: { nameAr, nameEn, sortOrder, isActive: true, deletedAt: null } },
        upsert: true,
      },
    })),
  );

  const governorates = await GovernorateModel.find({
    nameAr: { $in: SEED_GOVERNORATES.map((g) => g.nameAr) },
  })
    .setOptions({ withDeleted: true })
    .lean();
  const idByName = new Map(governorates.map((g) => [g.nameAr, g._id]));

  await AreaModel.bulkWrite(
    SEED_GOVERNORATES.flatMap((governorate) =>
      governorate.areas.map(({ nameAr, nameEn }) => ({
        updateOne: {
          filter: { governorateId: idByName.get(governorate.nameAr), nameAr },
          update: {
            $setOnInsert: {
              governorateId: idByName.get(governorate.nameAr),
              nameAr,
              nameEn,
              searchName: buildAreaSearchName(nameAr, nameEn),
              isActive: true,
              maxTravelFee: null,
              deletedAt: null,
            },
          },
          upsert: true,
        },
      })),
    ),
  );
};
