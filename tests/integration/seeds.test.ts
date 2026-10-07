import { describe, expect, it } from 'vitest';
import { useTestDatabase } from '../helpers/db';
import { runSeeds } from '../../src/database/seed';
import { GovernorateModel } from '../../src/database/models/location/governorate.model';
import { AreaModel } from '../../src/database/models/location/area.model';
import { ServiceCategoryModel } from '../../src/database/models/catalog/service-category.model';
import { CatalogServiceModel } from '../../src/database/models/catalog/catalog-service.model';

useTestDatabase();

const counts = async () => ({
  governorates: await GovernorateModel.countDocuments(),
  areas: await AreaModel.countDocuments(),
  categories: await ServiceCategoryModel.countDocuments(),
  services: await CatalogServiceModel.countDocuments(),
});

describe('seeds', () => {
  it('create launch data and are safe to run on every boot', async () => {
    await runSeeds();
    const first = await counts();
    expect(first).toEqual({ governorates: 3, areas: 48, categories: 5, services: 9 });

    await runSeeds();
    expect(await counts()).toEqual(first);
  });

  it('fill the area search field', async () => {
    await runSeeds();
    const area = await AreaModel.findOne({ nameAr: 'مدينة نصر' }).lean();
    expect(area!.searchName).toBe('مدينه نصر nasr city');
  });

  it('never overwrite admin edits', async () => {
    await runSeeds();
    await AreaModel.updateOne({ nameAr: 'المعادي' }, { nameEn: 'El Maadi', isActive: false });
    await runSeeds();
    expect(await AreaModel.findOne({ nameAr: 'المعادي' }).lean()).toMatchObject({
      nameEn: 'El Maadi',
      isActive: false,
    });
  });

  it('do not re-create something an admin deleted', async () => {
    await runSeeds();
    const packages = (await ServiceCategoryModel.findOne({ key: 'packages' }))!;
    await packages.softDelete();
    await runSeeds();
    expect(await ServiceCategoryModel.countDocuments({ key: 'packages' })).toBe(0);
    expect(
      await ServiceCategoryModel.countDocuments({ key: 'packages' }).setOptions({ withDeleted: true }),
    ).toBe(1);
  });
});
