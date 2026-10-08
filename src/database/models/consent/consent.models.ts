import { Schema, model } from 'mongoose';
import { UserRole } from '../../../interfaces/enums';
import {
  ConsentAction,
  ConsentKind,
  type IConsentDocument,
  type IConsentRecord,
} from '../../../interfaces/IConsent';

const appendOnly = (schema: Schema, name: string) =>
  schema.pre(['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace'], () => {
    throw new Error(`${name} is append-only`);
  });

const consentDocumentSchema = new Schema<IConsentDocument>(
  {
    kind: { type: String, enum: Object.values(ConsentKind), required: true },
    version: { type: Number, required: true, min: 1 },
    titleAr: { type: String, required: true, trim: true },
    titleEn: { type: String, trim: true, default: null },
    bodyAr: { type: String, required: true },
    bodyEn: { type: String, default: null },
    url: { type: String, default: null },
    roles: { type: [String], enum: Object.values(UserRole), required: true },
    publishedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);
consentDocumentSchema.index({ kind: 1, version: -1 }, { unique: true });
// Published versions never change (a new text is a new version).
appendOnly(consentDocumentSchema, 'consent_documents');

export const ConsentDocumentModel = model<IConsentDocument>('ConsentDocument', consentDocumentSchema);

const consentRecordSchema = new Schema<IConsentRecord>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    kind: { type: String, enum: Object.values(ConsentKind), required: true },
    version: { type: Number, required: true },
    documentId: { type: Schema.Types.ObjectId, ref: 'ConsentDocument', required: true },
    action: { type: String, enum: Object.values(ConsentAction), required: true },
    ip: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);
consentRecordSchema.index({ userId: 1, kind: 1, createdAt: -1 });
appendOnly(consentRecordSchema, 'consent_records');

export const ConsentRecordModel = model<IConsentRecord>('ConsentRecord', consentRecordSchema);
