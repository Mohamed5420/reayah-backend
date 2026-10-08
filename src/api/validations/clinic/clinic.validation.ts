import { ClinicStatus } from '../../../interfaces/IClinic';
import { weeklySlot } from '../provider/provider.validation';
import { objectId, paginationQuery, z } from '../zod';

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
/** Egyptian mobile (+201…) or landline (+20 2…, +20 3…, …). */
const clinicPhone = z
  .string()
  .trim()
  .regex(/^\+20(1[0125]\d{8}|[2-9]\d{7,8})$/, { error: 'validation.phone' })
  .openapi({ example: '+20224001234' });

/** Text address only — unknown fields (coordinates!) are refused by name. */
const clinicBody = z
  .strictObject({
    name: z.string().trim().min(2).max(120).openapi({ example: 'عيادة د. منى للأطفال' }),
    governorate_id: objectId,
    area_id: objectId,
    street: z.string().trim().min(2).max(200).openapi({ example: 'شارع مكرم عبيد' }),
    building: optionalText(50).openapi({ example: '12' }),
    floor: optionalText(20).openapi({ example: '3' }),
    landmark: optionalText(200).openapi({ example: 'أمام سيتي ستارز' }),
    phone: clinicPhone,
  })
  .openapi('ClinicInput');

const schedule = z.object({
  /** Appointment length in minutes; null = the service's duration. */
  slot_minutes: z.number().int().min(5).max(240).nullable(),
  /** Free slots are confirmed at once (default); false = the doctor accepts each request. */
  instant_confirm: z.boolean(),
  hours: z.array(weeklySlot),
});

export const ClinicSchemas = {
  idParams: z.object({ id: objectId }),
  createBody: clinicBody,
  updateBody: clinicBody.partial().extend({ is_active: z.boolean().optional() }).openapi('ClinicPatch'),
  licenceBody: z.strictObject({
    /** From POST /uploads with purpose `clinic_licence`. */
    file_key: z.string().min(1),
    expires_at: z.iso.date().nullable().optional().openapi({ example: '2028-12-31' }),
  }),
  scheduleBody: z.strictObject({
    slot_minutes: z.number().int().min(5).max(240).nullable().default(null),
    instant_confirm: z.boolean().default(true),
    hours: z.array(weeklySlot).max(50),
  }),
  clinic: z
    .object({
      id: z.string(),
      name: z.string(),
      governorate: z.object({ id: z.string(), name: z.string() }).nullable(),
      area: z.object({ id: z.string(), name: z.string() }).nullable(),
      street: z.string(),
      building: z.string().nullable(),
      floor: z.string().nullable(),
      landmark: z.string().nullable(),
      phone: z.string(),
      is_active: z.boolean(),
      status: z.enum(ClinicStatus),
      admin_message: z.string().nullable(),
      licence: z
        .object({
          uploaded_at: z.string(),
          expires_at: z.string().nullable(),
          file_url: z.string().nullable(),
        })
        .nullable(),
      /** This doctor's hours and settings here. */
      schedule: schedule.nullable(),
      created_at: z.string(),
    })
    .openapi('Clinic'),

  adminQuery: paginationQuery.extend({ status: z.enum(ClinicStatus).optional() }),
  adminClinic: z
    .object({
      id: z.string(),
      name: z.string(),
      owner: z.object({
        kind: z.enum(['provider', 'organization']),
        provider_profile_id: z.string().nullable(),
        organization_id: z.string().nullable(),
      }),
      governorate: z.object({ id: z.string(), name: z.string() }).nullable(),
      area: z.object({ id: z.string(), name: z.string() }).nullable(),
      street: z.string(),
      building: z.string().nullable(),
      floor: z.string().nullable(),
      landmark: z.string().nullable(),
      phone: z.string(),
      is_active: z.boolean(),
      status: z.enum(ClinicStatus),
      admin_message: z.string().nullable(),
      licence: z
        .object({
          uploaded_at: z.string(),
          expires_at: z.string().nullable(),
          file_url: z.string().nullable(),
        })
        .nullable(),
      submitted_at: z.string().nullable(),
      reviewed_at: z.string().nullable(),
      created_at: z.string(),
    })
    .openapi('AdminClinic'),
  decisionBody: z.strictObject({ message: z.string().trim().min(3).max(1000) }),
};
