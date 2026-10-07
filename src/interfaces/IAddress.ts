import type { Types } from 'mongoose';

/** Spec §4.2 `addresses` — structured text only. There are no coordinate fields, by design (§1). */
export interface IAddress {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  /** e.g. "البيت", "بيت بابا". */
  label: string;
  governorateId: Types.ObjectId;
  areaId: Types.ObjectId;
  street: string;
  building: string | null;
  floor: string | null;
  apartment: string | null;
  landmark: string | null;
  notes: string | null;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}
