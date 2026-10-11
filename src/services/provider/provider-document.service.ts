import { Container, Service } from 'typedi';
import type { Types } from 'mongoose';
import { ProviderDocumentModel } from '../../database/models/provider/provider-document.model';
import {
  DocumentReviewStatus,
  NO_BACK_PAGE,
  ProviderDocumentType,
  REQUIRED_PROVIDER_DOCUMENTS,
  SINGLE_PROVIDER_DOCUMENTS,
} from '../../interfaces/IProvider';
import { SettingsService } from '../settings/settings.service';
import { logger } from '../../utils/logger/winston';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/types-errors';
import { StorageService, mimeOfKey } from '../storage/storage.service';

/**
 * Verification documents (spec §4.4, §7.10). Files go through POST /uploads (purpose `provider_document`)
 * and are attached here. One current document per type (uploading a new one replaces it), except
 * certificates, which can be many. A card can carry its back as a second page (`backFileKey`); the
 * admin reviews the document as one. Documents the admin accepted ("matching") can't be deleted.
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

  /** What a provider must upload before submitting: the base list, plus the criminal record when required. */
  async requiredTypes(): Promise<ProviderDocumentType[]> {
    const criminal = await Container.get(SettingsService).get('criminal_record_required');
    return criminal
      ? [...REQUIRED_PROVIDER_DOCUMENTS, ProviderDocumentType.CRIMINAL_RECORD]
      : REQUIRED_PROVIDER_DOCUMENTS;
  }

  async attach(
    userId: string,
    profileId: Types.ObjectId,
    input: {
      type: ProviderDocumentType;
      fileKey: string;
      backFileKey?: string | null;
      expiresAt?: Date | null;
    },
  ) {
    if (input.backFileKey && NO_BACK_PAGE.includes(input.type)) {
      throw new ValidationError({ back_file_key: ['validation.no_back_page'] });
    }
    const promote = (key: string) =>
      this.storage.promote(key, {
        ownerId: userId,
        purpose: 'provider_document',
        destPrefix: `provider-documents/${String(profileId)}`,
      });
    const fileKey = await promote(input.fileKey);
    const backFileKey = input.backFileKey ? await promote(input.backFileKey) : null;

    if (SINGLE_PROVIDER_DOCUMENTS.includes(input.type)) {
      const previous = await ProviderDocumentModel.find({ providerProfileId: profileId, type: input.type });
      for (const document of previous) await this.discard(document);
    }

    const document = await ProviderDocumentModel.create({
      providerProfileId: profileId,
      type: input.type,
      fileKey,
      mime: mimeOfKey(fileKey),
      backFileKey,
      backMime: backFileKey ? mimeOfKey(backFileKey) : null,
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

  async withUrls<T extends { fileKey: string; backFileKey?: string | null }>(documents: T[]) {
    return Promise.all(
      documents.map(async (document) => ({
        document,
        fileUrl: await this.storage.signedUrl(document.fileKey),
        backFileUrl: document.backFileKey ? await this.storage.signedUrl(document.backFileKey) : null,
      })),
    );
  }

  private async discard(document: InstanceType<typeof ProviderDocumentModel>) {
    await document.softDelete();
    for (const key of [document.fileKey, document.backFileKey]) {
      if (!key) continue;
      await this.storage
        .delete(key)
        .catch((err: unknown) => logger.error(`Failed to delete provider file ${key}`, err));
    }
  }
}
