import { Container, Service } from 'typedi';
import type { Types } from 'mongoose';
import { OrganizationDocumentModel } from '../../database/models/organization/organization.models';
import { DocumentReviewStatus } from '../../interfaces/IProvider';
import type { OrganizationDocumentType } from '../../interfaces/IOrganization';
import { logger } from '../../utils/logger/winston';
import { ConflictError, NotFoundError } from '../../utils/types-errors';
import { StorageService, mimeOfKey } from '../storage/storage.service';

/**
 * Commercial register and tax card (spec §7.11 `/org/documents`). Files go through POST /uploads
 * (purpose `org_document`) and are attached here; uploading a type again replaces the previous one.
 * Documents the admin accepted ("matching") can't be deleted.
 */
@Service()
export class OrganizationDocumentService {
  private readonly storage = Container.get(StorageService);

  async list(organizationId: Types.ObjectId) {
    const documents = await OrganizationDocumentModel.find({ organizationId }).sort({ createdAt: 1 });
    return this.withUrls(documents);
  }

  async attach(
    userId: string,
    organizationId: Types.ObjectId,
    input: { type: OrganizationDocumentType; fileKey: string; expiresAt?: Date | null },
  ) {
    const fileKey = await this.storage.promote(input.fileKey, {
      ownerId: userId,
      purpose: 'org_document',
      destPrefix: `organization-documents/${String(organizationId)}`,
    });
    const previous = await OrganizationDocumentModel.find({ organizationId, type: input.type });
    for (const document of previous) await this.discard(document);
    const document = await OrganizationDocumentModel.create({
      organizationId,
      type: input.type,
      fileKey,
      mime: mimeOfKey(fileKey),
      expiresAt: input.expiresAt ?? null,
    });
    return (await this.withUrls([document]))[0];
  }

  async remove(organizationId: Types.ObjectId, documentId: string) {
    const document = await OrganizationDocumentModel.findOne({ _id: documentId, organizationId });
    if (!document) throw new NotFoundError('errors.document_not_found');
    if (document.status === DocumentReviewStatus.MATCHING)
      throw new ConflictError('errors.document_approved');
    await this.discard(document);
  }

  async withUrls<T extends { fileKey: string }>(documents: T[]) {
    return Promise.all(
      documents.map(async (document) => ({
        document,
        fileUrl: await this.storage.signedUrl(document.fileKey),
      })),
    );
  }

  private async discard(document: InstanceType<typeof OrganizationDocumentModel>) {
    await document.softDelete();
    await this.storage
      .delete(document.fileKey)
      .catch((err: unknown) => logger.error(`Failed to delete organization file ${document.fileKey}`, err));
  }
}
