import { objectId, z } from '../zod';

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

/**
 * Strict: unknown fields are refused by name (422 `validation.unknown_field`). In particular there is
 * no way to send coordinates — addresses are structured text only (spec §1, §7.5).
 */
const createAddressBody = z
  .strictObject({
    label: z.string().trim().min(1).max(50).openapi({ example: 'بيت بابا' }),
    governorate_id: objectId,
    area_id: objectId,
    street: z.string().trim().min(2).max(200).openapi({ example: 'شارع عباس العقاد' }),
    building: optionalText(50).openapi({ example: '15' }),
    floor: optionalText(20).openapi({ example: '4' }),
    apartment: optionalText(20).openapi({ example: '12' }),
    landmark: optionalText(200).openapi({ example: 'بجوار صيدلية العزبي' }),
    notes: optionalText(500).openapi({ example: 'الأسانسير عطلان' }),
    is_default: z.boolean().optional(),
  })
  .openapi('CreateAddress');

const named = z.object({ id: objectId, name: z.string() });

/** Request and response schemas for /addresses (spec §7.5). */
export const AddressSchemas = {
  idParams: z.object({ id: objectId }),
  createAddressBody,
  // The default moves via POST /addresses/{id}/default.
  updateAddressBody: createAddressBody.omit({ is_default: true }).partial().openapi('UpdateAddress'),
  address: z
    .object({
      id: objectId,
      label: z.string(),
      governorate: named,
      area: named,
      street: z.string(),
      building: z.string().nullable(),
      floor: z.string().nullable(),
      apartment: z.string().nullable(),
      landmark: z.string().nullable(),
      notes: z.string().nullable(),
      is_default: z.boolean(),
      /** false when the area has since been deactivated — the address can't be used for new bookings. */
      is_bookable: z.boolean(),
      full_text: z.string().openapi({ example: '15 شارع عباس العقاد، الدور 4، شقة 12، مدينة نصر، القاهرة' }),
    })
    .openapi('Address'),
};
