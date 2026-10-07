import type { Types } from 'mongoose';

/** Spec §4.2 — text-only locations. No coordinates anywhere, by design (§1). */
export interface IGovernorate {
  _id: Types.ObjectId;
  nameAr: string;
  nameEn: string | null;
  isActive: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface IArea {
  _id: Types.ObjectId;
  governorateId: Types.ObjectId;
  nameAr: string;
  nameEn: string | null;
  /** Only active areas (in active governorates) are bookable. */
  isActive: boolean;
  /** Admin cap in piastres: providers/organizations can't charge a higher travel fee here. null = no cap. */
  maxTravelFee: number | null;
  /** Normalized Arabic + English names for search (see normalizeSearchText). Maintained by the model. */
  searchName: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}
