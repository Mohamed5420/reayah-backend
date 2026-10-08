import { VerificationStatus } from '../../../interfaces/enums';
import { DocumentReviewStatus } from '../../../interfaces/IProvider';
import { OrganizationDocumentType, OrganizationType } from '../../../interfaces/IOrganization';
import { ProviderSchemas } from '../provider/provider.validation';
import { objectId, paginationQuery, piastres, timestamps, z } from '../zod';

const date = z.iso.date().openapi({ example: '2030-12-31' });

const checklist = z.object({
  info_completed: z.boolean(),
  documents_uploaded: z.boolean(),
  areas_selected: z.boolean(),
  services_set: z.boolean(),
  can_submit: z.boolean(),
});

const document = z
  .object({
    id: objectId,
    type: z.enum(OrganizationDocumentType),
    status: z.enum(DocumentReviewStatus),
    mime: z.string(),
    /** Signed, valid 10 minutes. */
    file_url: z.string(),
    expires_at: z.string().nullable(),
    review_note: z.string().nullable(),
    uploaded_at: z.string(),
  })
  .openapi('OrganizationDocument');

const serviceArea = ProviderSchemas.serviceArea
  .extend({
    is_active: z.boolean(),
    /** Approved staff covering the area and taking bookings (computed). */
    team_size: z.number(),
  })
  .openapi('OrganizationServiceArea');

const fields = {
  name: z.string().trim().min(2).max(120),
  type: z.enum(OrganizationType),
  commercial_register_no: z.string().trim().min(3).max(50),
  tax_id: z.string().trim().min(3).max(50),
  description: z.string().trim().max(2000).nullable(),
  phone: z
    .string()
    .trim()
    .regex(/^\+?\d{7,15}$/, { error: 'validation.phone' })
    .nullable(),
  /** Text only — never coordinates (spec §1). */
  address_text: z.string().trim().max(300).nullable(),
};

const organization = z
  .object({
    id: objectId,
    name: z.string(),
    type: z.enum(OrganizationType),
    commercial_register_no: z.string(),
    tax_id: z.string(),
    description: z.string().nullable(),
    phone: z.string().nullable(),
    address_text: z.string().nullable(),
    /** Signed, valid 10 minutes. */
    logo_url: z.string().nullable(),
    verification_status: z.enum(VerificationStatus),
    rejection_reason: z.string().nullable(),
    admin_message: z.string().nullable(),
    submitted_at: z.string().nullable(),
    reviewed_at: z.string().nullable(),
    onboarding: checklist,
    ...timestamps,
  })
  .openapi('Organization');

const owner = z.object({ id: objectId, full_name: z.string(), phone: z.string() }).nullable();

/** Spec §7.11 "Organization setup" and §7.15 organizations / verification. */
export const OrganizationSchemas = {
  idParams: z.object({ id: objectId }),
  createBody: z
    .strictObject({
      ...fields,
      description: fields.description.optional(),
      phone: fields.phone.optional(),
      address_text: fields.address_text.optional(),
    })
    .openapi('CreateOrganization'),
  updateBody: z.strictObject(fields).partial().openapi('UpdateOrganization'),
  organization,

  document,
  attachDocumentBody: z
    .strictObject({
      type: z.enum(OrganizationDocumentType),
      /** From POST /uploads with purpose `org_document`. */
      file_key: z.string().min(1).max(300),
      expires_at: date.nullable().optional(),
    })
    .openapi('AttachOrganizationDocument'),

  serviceArea,
  serviceAreasBody: z.strictObject({
    areas: z
      .array(
        z.strictObject({
          area_id: objectId,
          travel_fee: piastres.default(0),
          is_active: z.boolean().default(true),
        }),
      )
      .max(100),
  }),
  service: ProviderSchemas.providerService,
  servicesBody: z.strictObject({
    services: z
      .array(
        z.strictObject({
          service_id: objectId,
          price: piastres.min(1),
          is_active: z.boolean().default(true),
        }),
      )
      .max(100),
  }),

  // Admin
  queueItem: z
    .object({
      id: objectId,
      type: z.literal('organization'),
      name: z.string(),
      phone: z.string(),
      organization_type: z.enum(OrganizationType),
      status: z.enum(VerificationStatus),
      submitted_at: z.string().nullable(),
      documents_count: z.number(),
    })
    .openapi('OrganizationQueueItem'),
  reviewDetail: organization
    .omit({ onboarding: true })
    .extend({
      kind: z.literal('organization'),
      owner,
      commission_rate: z.number().nullable(),
      documents: z.array(document),
      service_areas: z.array(serviceArea),
      services: z.array(ProviderSchemas.providerService),
      onboarding: checklist,
    })
    .openapi('OrganizationReviewDetail'),
  adminListQuery: paginationQuery.extend({
    status: z.enum(VerificationStatus).optional(),
    search: z.string().trim().max(100).optional(),
  }),
  adminListItem: z
    .object({
      id: objectId,
      name: z.string(),
      type: z.enum(OrganizationType),
      verification_status: z.enum(VerificationStatus),
      owner,
      commission_rate: z.number().nullable(),
      service_areas_count: z.number(),
      services_count: z.number(),
      created_at: z.string(),
    })
    .openapi('AdminOrganizationListItem'),
  adminUpdateBody: z
    .strictObject({
      name: fields.name,
      type: fields.type,
      description: fields.description,
      phone: fields.phone,
      address_text: fields.address_text,
      /** Percent of the subtotal; null = the platform's commission_rate. */
      commission_rate: z.number().int().min(0).max(100).nullable(),
    })
    .partial()
    .openapi('AdminUpdateOrganization'),
};
