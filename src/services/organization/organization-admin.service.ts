import { Container, Service } from 'typedi';
import { Types, type ClientSession, type FilterQuery } from 'mongoose';
import { invalidateCacheNamespace } from '../../utils/cache/cache';
import { PROVIDER_PRICES_CACHE } from '../catalog/catalog.service';
import {
  OrganizationDocumentModel,
  OrganizationModel,
} from '../../database/models/organization/organization.models';
import { UserModel } from '../../database/models/user/user.model';
import { withTransaction } from '../../database/transaction';
import { VerificationStatus } from '../../interfaces/enums';
import { DocumentReviewStatus } from '../../interfaces/IProvider';
import { NotificationType } from '../../interfaces/INotification';
import {
  OrganizationDocumentType,
  type IOrganization,
  type OrganizationType,
} from '../../interfaces/IOrganization';
import type { Pagination } from '../../utils/response/pagination';
import { escapeRegExp } from '../../utils/text/arabic';
import { ConflictError, NotFoundError } from '../../utils/types-errors';
import { AuditService, applyPatch, type AuditContext } from '../audit/audit.service';
import { NotificationService } from '../notification/notification.service';
import { OrganizationService } from './organization.service';

const reviewedBy = (context: AuditContext) => ({
  reviewedBy: context.actorId ? new Types.ObjectId(context.actorId) : null,
  reviewedAt: new Date(),
});

export type OrganizationAdminPatch = {
  name?: string;
  type?: OrganizationType;
  description?: string | null;
  phone?: string | null;
  addressText?: string | null;
  /** Percent; null = the platform's commission_rate. */
  commissionRate?: number | null;
};

/**
 * Admin side of organizations (spec §7.15): verification through the shared queue
 * (`/admin/verifications?type=organization`) with the same decisions as providers, and
 * `/admin/organizations` (list, details, edit incl. a custom commission rate). Every write is audited.
 */
@Service()
export class OrganizationAdminService {
  private readonly audit = Container.get(AuditService);
  private readonly notifications = Container.get(NotificationService);
  private readonly organizations = Container.get(OrganizationService);

  // ── Verification queue ──

  /** Oldest submissions first. */
  async queue(status: VerificationStatus, pagination: Pagination) {
    const query = { verificationStatus: status };
    const [orgs, total] = await Promise.all([
      OrganizationModel.find(query)
        .sort({ submittedAt: 1, createdAt: 1 })
        .skip(pagination.skip)
        .limit(pagination.perPage)
        .lean(),
      OrganizationModel.countDocuments(query),
    ]);
    const [owners, counts] = await Promise.all([
      UserModel.find({ _id: { $in: orgs.map((o) => o.ownerUserId) } })
        .setOptions({ withDeleted: true })
        .lean(),
      OrganizationDocumentModel.aggregate<{ _id: Types.ObjectId; count: number }>([
        { $match: { organizationId: { $in: orgs.map((o) => o._id) }, deletedAt: null } },
        { $group: { _id: '$organizationId', count: { $sum: 1 } } },
      ]),
    ]);
    const ownerById = new Map(owners.map((u) => [String(u._id), u]));
    const countById = new Map(counts.map((c) => [String(c._id), c.count]));
    return {
      data: orgs.map((org) => ({
        org,
        owner: ownerById.get(String(org.ownerUserId)) ?? null,
        documentsCount: countById.get(String(org._id)) ?? 0,
      })),
      total,
    };
  }

  /** The id is an organization's? (The queue's routes take provider and organization ids alike.) */
  async isOrganization(id: string) {
    return Types.ObjectId.isValid(id) && Boolean(await OrganizationModel.exists({ _id: id }));
  }

  async getForReview(id: string) {
    const org = Types.ObjectId.isValid(id) ? await OrganizationModel.findById(id) : null;
    if (!org) throw new NotFoundError('errors.organization_not_found');
    const owner = await UserModel.findById(org.ownerUserId).setOptions({ withDeleted: true }).lean();
    return { org, owner, checklist: await this.organizations.checklist(org) };
  }

  /** Approves; documents still pending review are accepted with it (409 while any is not matching). */
  async approve(id: string, context: AuditContext) {
    await withTransaction(async (session) => {
      const org = await this.pending(id, session);
      if (
        await OrganizationDocumentModel.exists({
          organizationId: org._id,
          status: DocumentReviewStatus.NOT_MATCHING,
        }).session(session)
      ) {
        throw new ConflictError('errors.documents_not_matching');
      }
      await OrganizationDocumentModel.updateMany(
        { organizationId: org._id, status: DocumentReviewStatus.PENDING },
        { status: DocumentReviewStatus.MATCHING, ...reviewedBy(context) },
        { session },
      );
      Object.assign(org, {
        verificationStatus: VerificationStatus.APPROVED,
        rejectionReason: null,
        adminMessage: null,
        ...reviewedBy(context),
      });
      await org.save({ session });
      await this.audit.log(context, {
        action: 'organization.approve',
        entityType: 'organization',
        entityId: id,
      });
    });
    await this.notifyResult(id, 'org_verification_approved');
  }

  async requestChanges(
    id: string,
    input: { message: string; documents: OrganizationDocumentType[] },
    context: AuditContext,
  ) {
    await withTransaction(async (session) => {
      const org = await this.pending(id, session);
      await this.markDocuments(org._id, input.documents, input.message, context, session);
      Object.assign(org, {
        verificationStatus: VerificationStatus.CHANGES_REQUESTED,
        adminMessage: input.message,
        ...reviewedBy(context),
      });
      await org.save({ session });
      await this.audit.log(context, {
        action: 'organization.request_changes',
        entityType: 'organization',
        entityId: id,
        metadata: input,
      });
    });
    await this.notifyResult(id, 'org_verification_changes_requested', { message: input.message });
  }

  async reject(
    id: string,
    input: { reason: string; documents: OrganizationDocumentType[] },
    context: AuditContext,
  ) {
    await withTransaction(async (session) => {
      const org = await this.pending(id, session);
      await this.markDocuments(org._id, input.documents, input.reason, context, session);
      Object.assign(org, {
        verificationStatus: VerificationStatus.REJECTED,
        rejectionReason: input.reason,
        ...reviewedBy(context),
      });
      await org.save({ session });
      await this.audit.log(context, {
        action: 'organization.reject',
        entityType: 'organization',
        entityId: id,
        metadata: input,
      });
    });
    await this.notifyResult(id, 'org_verification_rejected', { reason: input.reason });
  }

  /** Reviews one organization document; null if the id isn't one (the route then tries provider documents). */
  async reviewDocument(
    documentId: string,
    input: {
      status: DocumentReviewStatus.MATCHING | DocumentReviewStatus.NOT_MATCHING;
      note?: string | null;
      expiresAt?: Date | null;
    },
    context: AuditContext,
  ) {
    const document = Types.ObjectId.isValid(documentId)
      ? await OrganizationDocumentModel.findById(documentId)
      : null;
    if (!document) return null;
    Object.assign(document, {
      status: input.status,
      reviewNote: input.note ?? null,
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      ...reviewedBy(context),
    });
    await document.save();
    await this.audit.log(context, {
      action: 'organization_document.review',
      entityType: 'organization_document',
      entityId: documentId,
      metadata: { status: input.status, organizationId: String(document.organizationId) },
    });
    if (
      document.type === OrganizationDocumentType.ACTIVITY_LICENCE &&
      document.status === DocumentReviewStatus.MATCHING &&
      (!document.expiresAt || document.expiresAt > new Date())
    ) {
      const lifted = await OrganizationModel.updateOne(
        { _id: document.organizationId, licencePausedAt: { $ne: null } },
        { licencePausedAt: null },
      );
      if (lifted.modifiedCount) await invalidateCacheNamespace(PROVIDER_PRICES_CACHE);
    }
    return document;
  }

  // ── /admin/organizations ──

  async list(filters: { status?: VerificationStatus; search?: string }, pagination: Pagination) {
    const query: FilterQuery<IOrganization> = {
      ...(filters.status ? { verificationStatus: filters.status } : {}),
      ...(filters.search ? { name: { $regex: escapeRegExp(filters.search.trim()), $options: 'i' } } : {}),
    };
    const [data, total] = await Promise.all([
      OrganizationModel.find(query)
        .sort({ createdAt: -1 })
        .skip(pagination.skip)
        .limit(pagination.perPage)
        .lean(),
      OrganizationModel.countDocuments(query),
    ]);
    const owners = await UserModel.find({ _id: { $in: data.map((o) => o.ownerUserId) } })
      .setOptions({ withDeleted: true })
      .lean();
    const ownerById = new Map(owners.map((u) => [String(u._id), u]));
    return {
      data: data.map((org) => ({ org, owner: ownerById.get(String(org.ownerUserId)) ?? null })),
      total,
    };
  }

  async update(id: string, patch: OrganizationAdminPatch, context: AuditContext) {
    const org = Types.ObjectId.isValid(id) ? await OrganizationModel.findById(id) : null;
    if (!org) throw new NotFoundError('errors.organization_not_found');
    const changes = applyPatch(org, patch);
    if (Object.keys(changes).length) {
      await org.save();
      await this.audit.log(context, {
        action: 'organization.update',
        entityType: 'organization',
        entityId: id,
        metadata: { changes },
      });
    }
    return org;
  }

  private async notifyResult(
    id: string,
    template:
      'org_verification_approved' | 'org_verification_changes_requested' | 'org_verification_rejected',
    params?: Record<string, string>,
  ) {
    const org = await OrganizationModel.findById(id).select('ownerUserId verificationStatus').lean();
    if (!org) return;
    await this.notifications.notify([org.ownerUserId], {
      type: NotificationType.VERIFICATION_RESULT,
      template,
      params,
      data: { organization_id: id, status: org.verificationStatus },
    });
  }

  private async pending(id: string, session: ClientSession) {
    const org = await OrganizationModel.findById(id).session(session);
    if (!org) throw new NotFoundError('errors.organization_not_found');
    if (org.verificationStatus !== VerificationStatus.PENDING) {
      throw new ConflictError('errors.verification_not_pending');
    }
    return org;
  }

  private markDocuments(
    organizationId: Types.ObjectId,
    types: OrganizationDocumentType[],
    note: string,
    context: AuditContext,
    session: ClientSession,
  ) {
    return OrganizationDocumentModel.updateMany(
      { organizationId, type: { $in: types } },
      { status: DocumentReviewStatus.NOT_MATCHING, reviewNote: note, ...reviewedBy(context) },
      { session },
    );
  }
}
