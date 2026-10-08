import { Schema, model, type Model } from 'mongoose';
import { ProviderType, VerificationStatus } from '../../../interfaces/enums';
import { DocumentReviewStatus } from '../../../interfaces/IProvider';
import {
  OrganizationDocumentType,
  OrganizationType,
  StaffInviteStatus,
  type IOrganization,
  type IStaffInvite,
  type IOrganizationDocument,
} from '../../../interfaces/IOrganization';
import { baseSchemaOptions, piastresValidator, uniqueAmongActive } from '../../schema-options';
import { softDeletePlugin, type SoftDeleteMethods } from '../../plugins/soft-delete.plugin';

type OrganizationModelType = Model<IOrganization, object, SoftDeleteMethods>;

const organizationSchema = new Schema<IOrganization, OrganizationModelType, SoftDeleteMethods>(
  {
    ownerUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, trim: true },
    type: { type: String, enum: Object.values(OrganizationType), required: true },
    commercialRegisterNo: { type: String, required: true, trim: true },
    taxId: { type: String, required: true, trim: true },
    description: { type: String, default: null },
    phone: { type: String, default: null },
    addressText: { type: String, default: null },
    logoKey: { type: String, default: null },
    verificationStatus: {
      type: String,
      enum: Object.values(VerificationStatus),
      default: VerificationStatus.DRAFT,
    },
    rejectionReason: { type: String, default: null },
    adminMessage: { type: String, default: null },
    submittedAt: { type: Date, default: null },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
    serviceAreas: {
      type: [
        new Schema(
          {
            areaId: { type: Schema.Types.ObjectId, ref: 'Area', required: true },
            travelFee: { type: Number, default: 0, validate: piastresValidator },
            isActive: { type: Boolean, default: true },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    services: {
      type: [
        new Schema(
          {
            serviceId: { type: Schema.Types.ObjectId, ref: 'CatalogService', required: true },
            price: { type: Number, required: true, validate: piastresValidator },
            isActive: { type: Boolean, default: true },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    commissionRate: { type: Number, default: null, min: 0, max: 100 },
    subscriptionPlanId: { type: Schema.Types.ObjectId, default: null },
    lapsedInvitesCount: { type: Number, default: 0 },
  },
  baseSchemaOptions,
);

organizationSchema.plugin(softDeletePlugin);
// One organization per owner account; one registration per commercial register number.
organizationSchema.index({ ownerUserId: 1 }, uniqueAmongActive);
organizationSchema.index({ commercialRegisterNo: 1 }, uniqueAmongActive);
organizationSchema.index({ verificationStatus: 1, submittedAt: 1 });
// Search by area (M3.3); one array per compound index (MongoDB can't index parallel arrays).
organizationSchema.index({ 'serviceAreas.areaId': 1, verificationStatus: 1 });
export const OrganizationModel = model<IOrganization, OrganizationModelType>(
  'Organization',
  organizationSchema,
);

type OrganizationDocumentModelType = Model<IOrganizationDocument, object, SoftDeleteMethods>;

const organizationDocumentSchema = new Schema<
  IOrganizationDocument,
  OrganizationDocumentModelType,
  SoftDeleteMethods
>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    type: { type: String, enum: Object.values(OrganizationDocumentType), required: true },
    fileKey: { type: String, required: true },
    mime: { type: String, required: true },
    status: {
      type: String,
      enum: Object.values(DocumentReviewStatus),
      default: DocumentReviewStatus.PENDING,
    },
    expiresAt: { type: Date, default: null },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
    reviewNote: { type: String, default: null },
  },
  baseSchemaOptions,
);

organizationDocumentSchema.plugin(softDeletePlugin);
organizationDocumentSchema.index({ organizationId: 1, type: 1 });

export const OrganizationDocumentModel = model<IOrganizationDocument, OrganizationDocumentModelType>(
  'OrganizationDocument',
  organizationDocumentSchema,
  'organization_documents',
);

const staffInviteSchema = new Schema<IStaffInvite>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    phone: { type: String, required: true },
    fullName: { type: String, required: true, trim: true },
    type: { type: String, enum: Object.values(ProviderType), required: true },
    status: { type: String, enum: Object.values(StaffInviteStatus), default: StaffInviteStatus.PENDING },
    invitedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    expiresAt: { type: Date, required: true },
    respondedAt: { type: Date, default: null },
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  baseSchemaOptions,
);
// One open invite per organization and phone.
staffInviteSchema.index(
  { organizationId: 1, phone: 1 },
  { unique: true, partialFilterExpression: { status: StaffInviteStatus.PENDING } },
);
staffInviteSchema.index({ phone: 1, status: 1 });
// Daily purge of invites never accepted.
staffInviteSchema.index({ status: 1, expiresAt: 1 });

export const StaffInviteModel = model<IStaffInvite>('StaffInvite', staffInviteSchema, 'org_staff_invites');
