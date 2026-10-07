import { Container, Service } from 'typedi';
import { Types, type ClientSession } from 'mongoose';
import { ProviderProfileModel } from '../../database/models/provider/provider-profile.model';
import { ProviderDocumentModel } from '../../database/models/provider/provider-document.model';
import { UserModel } from '../../database/models/user/user.model';
import { withTransaction } from '../../database/transaction';
import { VerificationStatus } from '../../interfaces/enums';
import { DocumentReviewStatus, type ProviderDocumentType } from '../../interfaces/IProvider';
import { invalidateCacheNamespace } from '../../utils/cache/cache';
import type { Pagination } from '../../utils/response/pagination';
import { ConflictError, NotFoundError, ValidationError, type ErrorFields } from '../../utils/types-errors';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { NotificationService } from '../notification/notification.service';
import { NotificationType } from '../../interfaces/INotification';
import { PROVIDER_PRICES_CACHE } from '../catalog/catalog.service';
import { EDITABLE_STATUSES, ProviderProfileService } from './provider-profile.service';

/** Checklist item → the field name reported when it's missing at submission. */
const MISSING_ITEM_FIELDS = {
  profileCompleted: ['profile', 'validation.onboarding_profile'],
  documentsUploaded: ['documents', 'validation.onboarding_documents'],
  areasSelected: ['service_areas', 'validation.onboarding_areas'],
  servicesSet: ['services', 'validation.onboarding_services'],
  availabilitySet: ['availability', 'validation.onboarding_availability'],
} as const;

/**
 * Provider verification (spec §6.7, §7.10, §7.15): draft/changes_requested/rejected → pending (provider
 * submits) → approved / changes_requested / rejected (admin). Only approved providers can appear in
 * search or take bookings. Every admin decision is one transaction and is audited.
 *
 * Each decision notifies the provider (`verification_result`).
 */
@Service()
export class VerificationService {
  private readonly profiles = Container.get(ProviderProfileService);
  private readonly audit = Container.get(AuditService);
  private readonly notifications = Container.get(NotificationService);

  // ── Provider ──

  /** 422 with one field per missing onboarding item, so the app can point at what's left. */
  async submit(userId: string) {
    const profile = await this.profiles.getOwn(userId);
    if (!EDITABLE_STATUSES.includes(profile.verificationStatus)) {
      throw new ConflictError('errors.verification_not_allowed');
    }
    const checklist = await this.profiles.checklist(profile);
    const fields: ErrorFields = {};
    for (const [item, [field, message]] of Object.entries(MISSING_ITEM_FIELDS)) {
      if (!checklist[item as keyof typeof MISSING_ITEM_FIELDS]) fields[field] = [message];
    }
    if (Object.keys(fields).length) throw new ValidationError(fields);

    profile.verificationStatus = VerificationStatus.PENDING;
    profile.submittedAt = new Date();
    profile.rejectionReason = null;
    profile.adminMessage = null;
    await profile.save();
    return profile;
  }

  // ── Admin ──

  /** Oldest submissions first. Organizations join this queue in Phase 3. */
  async queue(
    filters: { type: 'provider' | 'organization'; status: VerificationStatus },
    pagination: Pagination,
  ) {
    if (filters.type === 'organization') return { data: [], total: 0 };
    const query = { verificationStatus: filters.status };
    const [profiles, total] = await Promise.all([
      ProviderProfileModel.find(query)
        .sort({ submittedAt: 1, createdAt: 1 })
        .skip(pagination.skip)
        .limit(pagination.perPage),
      ProviderProfileModel.countDocuments(query),
    ]);
    const users = await UserModel.find({ _id: { $in: profiles.map((p) => p.userId) } })
      .setOptions({ withDeleted: true })
      .lean();
    const documentCounts = await ProviderDocumentModel.aggregate<{ _id: Types.ObjectId; count: number }>([
      { $match: { providerProfileId: { $in: profiles.map((p) => p._id) } } },
      { $group: { _id: '$providerProfileId', count: { $sum: 1 } } },
    ]);
    const userById = new Map(users.map((u) => [String(u._id), u]));
    const countById = new Map(documentCounts.map((c) => [String(c._id), c.count]));
    return {
      data: profiles.map((profile) => ({
        profile,
        user: userById.get(String(profile.userId))!,
        documentsCount: countById.get(String(profile._id)) ?? 0,
      })),
      total,
    };
  }

  async getForReview(profileId: string) {
    const profile = await ProviderProfileModel.findById(profileId);
    if (!profile) throw new NotFoundError('errors.provider_profile_not_found');
    const user = await UserModel.findById(profile.userId).setOptions({ withDeleted: true }).lean();
    return { profile, user: user!, checklist: await this.profiles.checklist(profile) };
  }

  /** Approves the provider; documents still pending review are accepted with it. */
  async approve(profileId: string, context: AuditContext) {
    await withTransaction(async (session) => {
      const profile = await this.pendingProfile(profileId, session);
      if (
        await ProviderDocumentModel.exists({
          providerProfileId: profile._id,
          status: DocumentReviewStatus.NOT_MATCHING,
        }).session(session)
      ) {
        throw new ConflictError('errors.documents_not_matching');
      }
      await ProviderDocumentModel.updateMany(
        { providerProfileId: profile._id, status: DocumentReviewStatus.PENDING },
        { status: DocumentReviewStatus.MATCHING, ...reviewedBy(context) },
        { session },
      );
      Object.assign(profile, {
        verificationStatus: VerificationStatus.APPROVED,
        rejectionReason: null,
        adminMessage: null,
        ...reviewedBy(context),
      });
      await profile.save({ session });
      await this.audit.log(context, {
        action: 'provider.approve',
        entityType: 'provider_profile',
        entityId: profileId,
      });
    });
    await invalidateCacheNamespace(PROVIDER_PRICES_CACHE);
    await this.notifyResult(profileId, 'verification_approved');
  }

  /** Sends the profile back: the named documents are marked "not matching" and must be re-uploaded. */
  async requestChanges(
    profileId: string,
    input: { message: string; documents: ProviderDocumentType[] },
    context: AuditContext,
  ) {
    await withTransaction(async (session) => {
      const profile = await this.pendingProfile(profileId, session);
      await this.markDocuments(profile._id, input.documents, input.message, context, session);
      Object.assign(profile, {
        verificationStatus: VerificationStatus.CHANGES_REQUESTED,
        adminMessage: input.message,
        ...reviewedBy(context),
      });
      await profile.save({ session });
      await this.audit.log(context, {
        action: 'provider.request_changes',
        entityType: 'provider_profile',
        entityId: profileId,
        metadata: input,
      });
    });
    await this.notifyResult(profileId, 'verification_changes_requested', { message: input.message });
  }

  async reject(
    profileId: string,
    input: { reason: string; documents: ProviderDocumentType[] },
    context: AuditContext,
  ) {
    await withTransaction(async (session) => {
      const profile = await this.pendingProfile(profileId, session);
      await this.markDocuments(profile._id, input.documents, input.reason, context, session);
      Object.assign(profile, {
        verificationStatus: VerificationStatus.REJECTED,
        rejectionReason: input.reason,
        ...reviewedBy(context),
      });
      await profile.save({ session });
      await this.audit.log(context, {
        action: 'provider.reject',
        entityType: 'provider_profile',
        entityId: profileId,
        metadata: input,
      });
    });
    await this.notifyResult(profileId, 'verification_rejected', { reason: input.reason });
  }

  /** POST /admin/documents/{id}/review — one document, any time (e.g. a renewed license). */
  async reviewDocument(
    documentId: string,
    input: {
      status: DocumentReviewStatus.MATCHING | DocumentReviewStatus.NOT_MATCHING;
      note?: string | null;
      expiresAt?: Date | null;
    },
    context: AuditContext,
  ) {
    const document = await ProviderDocumentModel.findById(documentId);
    if (!document) throw new NotFoundError('errors.document_not_found');
    Object.assign(document, {
      status: input.status,
      reviewNote: input.note ?? null,
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      ...reviewedBy(context),
    });
    await document.save();
    await this.audit.log(context, {
      action: 'provider_document.review',
      entityType: 'provider_document',
      entityId: documentId,
      metadata: { status: input.status, providerProfileId: String(document.providerProfileId) },
    });
    return document;
  }

  private async notifyResult(
    profileId: string,
    template: 'verification_approved' | 'verification_changes_requested' | 'verification_rejected',
    params?: Record<string, string>,
  ) {
    const profile = await ProviderProfileModel.findById(profileId).select('userId verificationStatus').lean();
    if (!profile) return;
    await this.notifications.notify([profile.userId], {
      type: NotificationType.VERIFICATION_RESULT,
      template,
      params,
      data: { status: profile.verificationStatus },
    });
  }

  private async pendingProfile(profileId: string, session: ClientSession) {
    const profile = await ProviderProfileModel.findById(profileId).session(session);
    if (!profile) throw new NotFoundError('errors.provider_profile_not_found');
    if (profile.verificationStatus !== VerificationStatus.PENDING) {
      throw new ConflictError('errors.verification_not_pending');
    }
    return profile;
  }

  private markDocuments(
    profileId: Types.ObjectId,
    types: ProviderDocumentType[],
    note: string,
    context: AuditContext,
    session: ClientSession,
  ) {
    return ProviderDocumentModel.updateMany(
      { providerProfileId: profileId, type: { $in: types } },
      { status: DocumentReviewStatus.NOT_MATCHING, reviewNote: note, ...reviewedBy(context) },
      { session },
    );
  }
}

const reviewedBy = (context: AuditContext) => ({
  reviewedBy: context.actorId ? new Types.ObjectId(context.actorId) : null,
  reviewedAt: new Date(),
});
