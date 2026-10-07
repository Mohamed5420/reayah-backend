import { Container, Service } from 'typedi';
import { Types } from 'mongoose';
import { MedicalDocumentModel } from '../../database/models/patient/medical-records.model';
import type { MedicalDocumentType } from '../../interfaces/IMedical';
import { logger } from '../../utils/logger/winston';
import { NotFoundError } from '../../utils/types-errors';
import type { AuditContext } from '../audit/audit.service';
import { StorageService, mimeOfKey } from '../storage/storage.service';
import { auditMedical } from './medical-audit';

/**
 * Medical documents (spec §7.6): files first go through POST /uploads (purpose `medical_document`),
 * then are attached here, which moves them out of `tmp/`. Read through 10-minute signed URLs only.
 */
@Service()
export class MedicalDocumentService {
  private readonly storage = Container.get(StorageService);

  async list(profileId: string, context: AuditContext) {
    const documents = await MedicalDocumentModel.find({ patientProfileId: profileId }).sort({
      createdAt: -1,
    });
    await auditMedical(context, 'medical_profile.read', profileId, { section: 'documents' });
    return Promise.all(
      documents.map(async (document) => ({
        document,
        fileUrl: await this.storage.signedUrl(document.fileKey),
      })),
    );
  }

  async attach(
    userId: string,
    profileId: string,
    input: { fileKey: string; type: MedicalDocumentType; title?: string | null },
    context: AuditContext,
  ) {
    const fileKey = await this.storage.promote(input.fileKey, {
      ownerId: userId,
      purpose: 'medical_document',
      destPrefix: `medical-documents/${profileId}`,
    });
    const document = await MedicalDocumentModel.create({
      patientProfileId: profileId,
      type: input.type,
      title: input.title ?? null,
      fileKey,
      mime: mimeOfKey(fileKey),
      uploadedBy: new Types.ObjectId(userId),
    });
    await auditMedical(context, 'medical_document.create', profileId, { documentId: String(document._id) });
    return { document, fileUrl: await this.storage.signedUrl(fileKey) };
  }

  /** Removes the record and the stored file (a failed file delete is logged, not surfaced). */
  async remove(profileId: string, documentId: string, context: AuditContext) {
    const document = await MedicalDocumentModel.findOne({ _id: documentId, patientProfileId: profileId });
    if (!document) throw new NotFoundError('errors.document_not_found');
    await document.softDelete();
    await this.storage
      .delete(document.fileKey)
      .catch((err: unknown) => logger.error(`Failed to delete medical file ${document.fileKey}`, err));
    await auditMedical(context, 'medical_document.delete', profileId, { documentId });
  }
}
