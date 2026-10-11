import { Schema, model, type Model } from 'mongoose';
import {
  DocumentReviewStatus,
  ProviderDocumentType,
  type IProviderDocument,
} from '../../../interfaces/IProvider';
import { baseSchemaOptions } from '../../schema-options';
import { softDeletePlugin, type SoftDeleteMethods } from '../../plugins/soft-delete.plugin';

type ProviderDocumentModelType = Model<IProviderDocument, object, SoftDeleteMethods>;

const providerDocumentSchema = new Schema<IProviderDocument, ProviderDocumentModelType, SoftDeleteMethods>(
  {
    providerProfileId: { type: Schema.Types.ObjectId, ref: 'ProviderProfile', required: true },
    type: { type: String, enum: Object.values(ProviderDocumentType), required: true },
    fileKey: { type: String, required: true },
    mime: { type: String, required: true },
    backFileKey: { type: String, default: null },
    backMime: { type: String, default: null },
    status: {
      type: String,
      enum: Object.values(DocumentReviewStatus),
      default: DocumentReviewStatus.PENDING,
    },
    expiresAt: { type: Date, default: null },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
    reviewNote: { type: String, default: null },
    // When the provider was last warned that this document expires soon (daily job).
    expiryNoticeAt: { type: Date, default: null },
  },
  baseSchemaOptions,
);

providerDocumentSchema.plugin(softDeletePlugin);
providerDocumentSchema.index({ providerProfileId: 1, type: 1 });
// Daily expiry job (M1.8): documents expiring soon.
providerDocumentSchema.index({ expiresAt: 1 });

export const ProviderDocumentModel = model<IProviderDocument, ProviderDocumentModelType>(
  'ProviderDocument',
  providerDocumentSchema,
  'provider_documents',
);
