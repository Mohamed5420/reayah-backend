import type { Types } from 'mongoose';
import type { PricingUnit, ProviderType } from './enums';
import type { BookingType } from './IBooking';

/** Spec §4.5 — nursing, doctor_home_visit, video_consultation, elderly_care, packages. */
export interface IServiceCategory {
  _id: Types.ObjectId;
  /** Stable slug, e.g. `nursing`. */
  key: string;
  nameAr: string;
  nameEn: string | null;
  iconUrl: string | null;
  isActive: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/** Admin-defined catalog entry (spec §4.5 `services`). Providers set their own price per service. */
export interface ICatalogService {
  _id: Types.ObjectId;
  categoryId: Types.ObjectId;
  nameAr: string;
  nameEn: string | null;
  descriptionAr: string | null;
  descriptionEn: string | null;
  providerType: ProviderType;
  pricingUnit: PricingUnit;
  defaultDurationMinutes: number;
  /** Optional admin bounds on provider prices, piastres. */
  minPrice: number | null;
  maxPrice: number | null;
  /** How it can be booked: nursing → [home_visit]; doctor consultations → home and clinic. Missing = home. */
  visitTypes: BookingType[];
  /** Clinic-visit bounds; null = use minPrice / maxPrice. */
  clinicMinPrice: number | null;
  clinicMaxPrice: number | null;
  isActive: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}
