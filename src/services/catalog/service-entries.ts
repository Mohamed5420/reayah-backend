import { Types } from 'mongoose';
import { BookingType } from '../../interfaces/IBooking';
import type { ErrorFields } from '../../utils/types-errors';
import type { ServiceRow } from './catalog.service';
import { priceBounds, withinBounds, type PricedVisitType } from './visit-types';

export type ServiceEntryInput = {
  serviceId: string;
  price: number;
  isActive: boolean;
  visitType?: PricedVisitType;
};

const addError = (fields: ErrorFields, key: string, message: string) => {
  (fields[key] ??= []).push(message);
};

/**
 * Checks a provider's or organization's service list (PUT replaces it whole): each (service, visit type)
 * once, an active catalog service, a visit type the service allows (and the owner may offer), and a price
 * within that visit type's admin bounds. Returns every problem as `services.<i>.<field>`, plus the
 * entries ready to save.
 */
export const checkServiceEntries = (
  entries: ServiceEntryInput[],
  catalog: Map<string, ServiceRow>,
  options: { clinicAllowed: boolean },
) => {
  const fields: ErrorFields = {};
  const seen = new Set<string>();
  for (const [i, entry] of entries.entries()) {
    const visitType = entry.visitType ?? BookingType.HOME_VISIT;
    const key = `${entry.serviceId}:${visitType}`;
    if (seen.has(key)) addError(fields, `services.${i}.service_id`, 'validation.duplicate');
    seen.add(key);
    const service = catalog.get(entry.serviceId);
    if (!service) {
      addError(fields, `services.${i}.service_id`, 'validation.service_unavailable');
      continue;
    }
    if (
      !service.visitTypes.includes(visitType) ||
      (visitType === BookingType.CLINIC_VISIT && !options.clinicAllowed)
    ) {
      addError(fields, `services.${i}.visit_type`, 'validation.visit_type_not_offered');
    } else if (!withinBounds(priceBounds(service, visitType), entry.price)) {
      addError(fields, `services.${i}.price`, 'validation.price_out_of_range');
    }
  }
  return {
    fields,
    rows: entries.map((e) => ({
      serviceId: new Types.ObjectId(e.serviceId),
      price: e.price,
      isActive: e.isActive,
      visitType: e.visitType ?? BookingType.HOME_VISIT,
    })),
  };
};
