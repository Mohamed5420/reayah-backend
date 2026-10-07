import { Service } from 'typedi';
import { Types } from 'mongoose';
import { GovernorateModel } from '../../database/models/location/governorate.model';
import { AreaModel } from '../../database/models/location/area.model';
import { cached } from '../../utils/cache/cache';
import { escapeRegExp, normalizeSearchText } from '../../utils/text/arabic';
import { NotFoundError } from '../../utils/types-errors';
import type { Pagination } from '../../utils/response/pagination';

export const LOCATIONS_CACHE = 'locations';
const CACHE_TTL_SECONDS = 600;
const ARABIC = { locale: 'ar' };

/** Cache-friendly plain shapes (both languages; the presenter picks one). */
export type GovernorateRow = { id: string; nameAr: string; nameEn: string | null };
export type AreaRow = {
  id: string;
  governorateId: string;
  nameAr: string;
  nameEn: string | null;
  maxTravelFee: number | null;
};

const toAreaRow = (a: {
  _id: Types.ObjectId;
  governorateId: Types.ObjectId;
  nameAr: string;
  nameEn: string | null;
  maxTravelFee: number | null;
}): AreaRow => ({
  id: String(a._id),
  governorateId: String(a.governorateId),
  nameAr: a.nameAr,
  nameEn: a.nameEn,
  maxTravelFee: a.maxTravelFee,
});

/** Public, bookable locations (spec §4.2, §7.3): only active areas inside active governorates. */
@Service()
export class LocationService {
  activeGovernorates(): Promise<GovernorateRow[]> {
    return cached(LOCATIONS_CACHE, 'governorates', CACHE_TTL_SECONDS, async () => {
      const docs = await GovernorateModel.find({ isActive: true })
        .collation(ARABIC)
        .sort({ sortOrder: 1, nameAr: 1 })
        .lean();
      return docs.map((g) => ({ id: String(g._id), nameAr: g.nameAr, nameEn: g.nameEn }));
    });
  }

  /** 404 if the governorate doesn't exist or isn't active. */
  async activeAreasOf(governorateId: string): Promise<AreaRow[]> {
    const governorates = await this.activeGovernorates();
    if (!governorates.some((g) => g.id === governorateId)) {
      throw new NotFoundError('errors.governorate_not_found');
    }
    return cached(LOCATIONS_CACHE, `areas:${governorateId}`, CACHE_TTL_SECONDS, async () => {
      const docs = await AreaModel.find({ governorateId, isActive: true })
        .collation(ARABIC)
        .sort({ nameAr: 1 })
        .lean();
      return docs.map(toAreaRow);
    });
  }

  /** Area search for the provider coverage multi-select. Tolerates Arabic spelling variants. */
  async searchAreas(filters: { search?: string; governorateId?: string }, { skip, perPage }: Pagination) {
    const governorates = await this.activeGovernorates();
    const activeIds = governorates.map((g) => new Types.ObjectId(g.id));
    const query = {
      isActive: true,
      governorateId: filters.governorateId
        ? { $in: activeIds.filter((id) => id.equals(filters.governorateId!)) }
        : { $in: activeIds },
      ...(filters.search
        ? { searchName: { $regex: escapeRegExp(normalizeSearchText(filters.search)) } }
        : {}),
    };

    const [docs, total] = await Promise.all([
      AreaModel.find(query).collation(ARABIC).sort({ nameAr: 1 }).skip(skip).limit(perPage).lean(),
      AreaModel.countDocuments(query),
    ]);
    const governorateById = new Map(governorates.map((g) => [g.id, g]));
    return {
      data: docs.map((doc) => ({
        ...toAreaRow(doc),
        governorate: governorateById.get(String(doc.governorateId))!,
      })),
      total,
    };
  }

  /** The area if it's bookable right now (active, in an active governorate), else null. */
  async findBookableArea(areaId: string): Promise<AreaRow | null> {
    if (!Types.ObjectId.isValid(areaId)) return null;
    const area = await AreaModel.findOne({ _id: areaId, isActive: true }).lean();
    if (!area) return null;
    const governorates = await this.activeGovernorates();
    return governorates.some((g) => g.id === String(area.governorateId)) ? toAreaRow(area) : null;
  }

  /**
   * Names of areas and their governorates for display — including ones an admin has since
   * deactivated (saved addresses keep showing them, flagged `bookable: false`).
   */
  async describeAreas(areaIds: string[]): Promise<Map<string, AreaDescription>> {
    const areas = await AreaModel.find({ _id: { $in: areaIds } })
      .setOptions({ withDeleted: true })
      .lean();
    const governorates = await GovernorateModel.find({ _id: { $in: areas.map((a) => a.governorateId) } })
      .setOptions({ withDeleted: true })
      .lean();
    const governorateById = new Map(governorates.map((g) => [String(g._id), g]));

    return new Map(
      areas.map((area) => {
        const governorate = governorateById.get(String(area.governorateId))!;
        return [
          String(area._id),
          {
            area: {
              id: String(area._id),
              nameAr: area.nameAr,
              nameEn: area.nameEn,
              maxTravelFee: area.maxTravelFee,
            },
            governorate: {
              id: String(governorate._id),
              nameAr: governorate.nameAr,
              nameEn: governorate.nameEn,
            },
            bookable: area.isActive && !area.deletedAt && governorate.isActive && !governorate.deletedAt,
          },
        ];
      }),
    );
  }
}

export type AreaDescription = {
  area: { id: string; nameAr: string; nameEn: string | null; maxTravelFee: number | null };
  governorate: GovernorateRow;
  bookable: boolean;
};
