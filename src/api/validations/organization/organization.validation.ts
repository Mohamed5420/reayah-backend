import { Gender, ProviderType, VerificationStatus } from '../../../interfaces/enums';
import { EGYPT_MOBILE } from '../../../services/auth/auth.constants';
import { DocumentReviewStatus } from '../../../interfaces/IProvider';
import {
  OrganizationDocumentType,
  OrganizationType,
  StaffInviteStatus,
} from '../../../interfaces/IOrganization';
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

const staffStatus = z.enum(['active', 'suspended', 'pending_verification']).openapi({
  description:
    'active = verified and not suspended; suspended by the owner; pending_verification = not approved yet',
});

const staffMember = z
  .object({
    id: objectId,
    user_id: objectId,
    full_name: z.string(),
    phone: z.string(),
    gender: z.enum(Gender).nullable(),
    /** Signed, valid 10 minutes. */
    avatar_url: z.string().nullable(),
    type: z.enum(ProviderType).nullable(),
    status: staffStatus,
    verification_status: z.enum(VerificationStatus),
    is_accepting_bookings: z.boolean(),
    is_online: z.boolean(),
    rating_avg: z.number(),
    completed_visits: z.number(),
    service_area_ids: z.array(objectId),
    service_ids: z.array(objectId),
  })
  .openapi('StaffMember');

/** Team management (spec §7.11 "Dashboard & team", M3.2). */
export const StaffSchemas = {
  idParams: z.object({ id: objectId }),
  inviteBody: z
    .strictObject({
      phone: z.string().trim().regex(EGYPT_MOBILE, { error: 'validation.phone' }),
      full_name: z.string().trim().min(2).max(100),
      type: z.enum(ProviderType),
    })
    .openapi('StaffInviteRequest'),
  invite: z
    .object({
      id: objectId,
      phone: z.string(),
      full_name: z.string(),
      type: z.enum(ProviderType),
      status: z.enum(StaffInviteStatus),
      expires_at: z.string(),
      created_at: z.string(),
    })
    .openapi('StaffInvite'),
  /** What an invitee sees. */
  receivedInvite: z
    .object({
      id: objectId,
      organization_name: z.string(),
      type: z.enum(ProviderType),
      expires_at: z.string(),
    })
    .openapi('ReceivedStaffInvite'),
  listQuery: paginationQuery.extend({
    status: staffStatus.optional(),
    type: z.enum(ProviderType).optional(),
  }),
  member: staffMember,
  detail: staffMember
    .extend({
      services: z.array(ProviderSchemas.providerService),
      service_areas: z.array(ProviderSchemas.serviceArea),
      availability: ProviderSchemas.availability.shape.slots,
      performance: z.object({
        completed_visits: z.number(),
        completed_last_30_days: z.number(),
        rating_avg: z.number(),
        rating_count: z.number(),
        /** Percent of visits started within the grace period; null before the first one. */
        on_time_rate: z.number().nullable(),
      }),
      joined_at: z.string(),
    })
    .openapi('StaffMemberDetail'),
  updateBody: z
    .strictObject({
      status: z.enum(['active', 'suspended']).optional(),
      /** From the organization's services, matching the member's type (nurse / doctor). */
      service_ids: z.array(objectId).max(100).optional(),
    })
    .openapi('UpdateStaffMember'),
  areasBody: z
    .strictObject({ area_ids: z.array(objectId).max(100) })
    .openapi({ description: "Areas from the organization's own list; its travel fee applies." }),
  availabilityBody: ProviderSchemas.availabilityBody,
};
