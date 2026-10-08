import { BookingType } from '../../interfaces/IBooking';

/**
 * Visit types (clinic visits, C1). A catalog service lists the visit types it can be booked as
 * (`visitTypes`: nursing → home only; doctor consultations → home and clinic). Providers and
 * organizations price each (service, visit type) as its own entry. Entries saved before clinic visits
 * have no `visitType` and count as home visits — so every query that matches an entry for a home
 * visit uses `visitTypeMatch(HOME_VISIT)` / `isVisitType(entry, HOME_VISIT)`, never a bare serviceId.
 */
export const { HOME_VISIT, CLINIC_VISIT } = BookingType;

/** The visit types a provider or organization can price (video stays deferred). */
export const PRICED_VISIT_TYPES = [HOME_VISIT, CLINIC_VISIT] as const;
export type PricedVisitType = (typeof PRICED_VISIT_TYPES)[number];

export const visitTypeOf = (entry: { visitType?: BookingType | null }): BookingType =>
  entry.visitType ?? HOME_VISIT;

export const isVisitType = (entry: { visitType?: BookingType | null }, type: BookingType) =>
  visitTypeOf(entry) === type;

/** Mongo condition on an embedded entry (inside `$elemMatch`): home also matches entries without the field. */
export const visitTypeMatch = (type: BookingType) =>
  type === HOME_VISIT ? { visitType: { $ne: CLINIC_VISIT } } : { visitType: type };

/** The same rule inside an aggregation `$filter` over `$$this`. */
export const visitTypeExpr = (type: BookingType) =>
  type === HOME_VISIT ? { $ne: ['$$this.visitType', CLINIC_VISIT] } : { $eq: ['$$this.visitType', type] };

/** The active entry for a service and visit type, if offered. */
export const offeredEntry = <
  T extends { serviceId: unknown; isActive: boolean; visitType?: BookingType | null },
>(
  entries: T[],
  serviceId: string,
  type: BookingType = HOME_VISIT,
) => entries.find((s) => s.isActive && String(s.serviceId) === serviceId && isVisitType(s, type));

/** Admin price bounds for a visit type: clinic bounds fall back to the general ones. */
export const priceBounds = (
  service: {
    minPrice: number | null;
    maxPrice: number | null;
    clinicMinPrice?: number | null;
    clinicMaxPrice?: number | null;
  },
  type: BookingType,
) =>
  type === CLINIC_VISIT
    ? { min: service.clinicMinPrice ?? service.minPrice, max: service.clinicMaxPrice ?? service.maxPrice }
    : { min: service.minPrice, max: service.maxPrice };

export const withinBounds = (bounds: { min: number | null; max: number | null }, price: number) =>
  (bounds.min === null || price >= bounds.min) && (bounds.max === null || price <= bounds.max);
