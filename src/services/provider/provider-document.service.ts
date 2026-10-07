import { Container, Service } from 'typedi';
import type { Types } from 'mongoose';
import { ProviderDocumentModel } from '../../database/models/provider/provider-document.model';
import {
  DocumentReviewStatus,
  ProviderDocumentType,
  REQUIRED_PROVIDER_DOCUMENTS,
} from '../../interfaces/IProvider';
import { logger } from '../../utils/logger/winston';
import { ConflictError, NotFoundError } from '../../utils/types-errors';
import { StorageService, mimeOfKey } from '../storage/storage.service';

/**
 * Verification documents (spec §4.4, §7.10). Files go through POST /uploads (purpose `provider_document`)
 * and are attached here. One current document per required type — uploading a new one replaces it.
 * Certificates can be many. Documents the admin accepted ("matching") can't be deleted.
 */
@Service()
export class ProviderDocumentService {
  private readonly storage = Container.get(StorageService);

  async list(profileId: Types.ObjectId) {
    const documents = await ProviderDocumentModel.find({ providerProfileId: profileId }).sort({
      createdAt: 1,
    });
    return this.withUrls(documents);
  }

  async attach(
    userId: string,
    profileId: Types.ObjectId,
    input: { type: ProviderDocumentType; fileKey: string; expiresAt?: Date | null },
  ) {
    const fileKey = await this.storage.promote(input.fileKey, {
      ownerId: userId,
      purpose: 'provider_document',
      destPrefix: `provider-documents/${String(profileId)}`,
    });

    if (REQUIRED_PROVIDER_DOCUMENTS.includes(input.type)) {
      const previous = await ProviderDocumentModel.find({ providerProfileId: profileId, type: input.type });
      for (const document of previous) await this.discard(document);
    }

    const document = await ProviderDocumentModel.create({
      providerProfileId: profileId,
      type: input.type,
      fileKey,
      mime: mimeOfKey(fileKey),
      expiresAt: input.expiresAt ?? null,
    });
    return (await this.withUrls([document]))[0];
  }

  async remove(profileId: Types.ObjectId, documentId: string) {
    const document = await ProviderDocumentModel.findOne({ _id: documentId, providerProfileId: profileId });
    if (!document) throw new NotFoundError('errors.document_not_found');
    if (document.status === DocumentReviewStatus.MATCHING) {
      throw new ConflictError('errors.document_approved');
    }
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

  private async discard(document: InstanceType<typeof ProviderDocumentModel>) {
    await document.softDelete();
    await this.storage
      .delete(document.fileKey)
      .catch((err: unknown) => logger.error(`Failed to delete provider file ${document.fileKey}`, err));
  }
}
