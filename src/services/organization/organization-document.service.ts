import { Container, Service } from 'typedi';
import type { Types } from 'mongoose';
import { OrganizationDocumentModel } from '../../database/models/organization/organization.models';
import { DocumentReviewStatus } from '../../interfaces/IProvider';
import { OrganizationDocumentType, type IssuingAuthority } from '../../interfaces/IOrganization';
import { logger } from '../../utils/logger/winston';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/types-errors';
import { StorageService, mimeOfKey } from '../storage/storage.service';

/**
 * Commercial register, tax card, activity licence (with its issuing authority and expiry) and the
 * manager's ID card (front + back) — spec §7.11 `/org/documents`. Files go through POST /uploads
 * (purpose `org_document`) and are attached here; uploading a type again replaces the previous one.
 * Documents the admin accepted ("matching") can't be deleted. The files sit in the private bucket and
 * are only ever shown through 10-minute links (the same as providers' ID cards).
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
    input: {
      type: OrganizationDocumentType;
      fileKey: string;
      backFileKey?: string | null;
      issuingAuthority?: IssuingAuthority | null;
      expiresAt?: Date | null;
    },
  ) {
    if (input.type === OrganizationDocumentType.ACTIVITY_LICENCE) {
      const fields: Record<string, string[]> = {};
      if (!input.issuingAuthority) fields.issuing_authority = ['validation.required'];
      if (!input.expiresAt) fields.expires_at = ['validation.required'];
      if (Object.keys(fields).length) throw new ValidationError(fields);
    } else if (input.issuingAuthority) {
      throw new ValidationError({ issuing_authority: ['validation.unknown_field'] });
    }
    const promote = (key: string) =>
      this.storage.promote(key, {
        ownerId: userId,
        purpose: 'org_document',
        destPrefix: `organization-documents/${String(organizationId)}`,
      });
    const fileKey = await promote(input.fileKey);
    const backFileKey = input.backFileKey ? await promote(input.backFileKey) : null;
    const previous = await OrganizationDocumentModel.find({ organizationId, type: input.type });
    for (const document of previous) await this.discard(document);
    const document = await OrganizationDocumentModel.create({
      organizationId,
      type: input.type,
      fileKey,
      mime: mimeOfKey(fileKey),
      backFileKey,
      backMime: backFileKey ? mimeOfKey(backFileKey) : null,
      issuingAuthority: input.issuingAuthority ?? null,
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

  async withUrls<T extends { fileKey: string; backFileKey?: string | null }>(documents: T[]) {
    return Promise.all(
      documents.map(async (document) => ({
        document,
        fileUrl: await this.storage.signedUrl(document.fileKey),
        backFileUrl: document.backFileKey ? await this.storage.signedUrl(document.backFileKey) : null,
      })),
    );
  }

  private async discard(document: InstanceType<typeof OrganizationDocumentModel>) {
    await document.softDelete();
    for (const key of [document.fileKey, document.backFileKey]) {
      if (!key) continue;
      await this.storage
        .delete(key)
        .catch((err: unknown) => logger.error(`Failed to delete organization file ${key}`, err));
    }
  }
}
