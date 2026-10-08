import { Container, Service } from 'typedi';
import { Types, type ClientSession } from 'mongoose';
import { ConsentDocumentModel, ConsentRecordModel } from '../../database/models/consent/consent.models';
import { UserRole } from '../../interfaces/enums';
import {
  ConsentAction,
  ConsentKind,
  type IConsentDocument,
  type IConsentRecord,
} from '../../interfaces/IConsent';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { ConflictError, ValidationError } from '../../utils/types-errors';

const KIND_ORDER = Object.values(ConsentKind);

/** Who must accept each kind unless the published version says otherwise. */
export const DEFAULT_CONSENT_ROLES: Record<ConsentKind, UserRole[]> = {
  [ConsentKind.TERMS]: [UserRole.PATIENT, UserRole.PROVIDER, UserRole.PROVIDER_STAFF, UserRole.OWNER],
  [ConsentKind.PRIVACY]: [UserRole.PATIENT, UserRole.PROVIDER, UserRole.PROVIDER_STAFF, UserRole.OWNER],
  [ConsentKind.HEALTH_DATA]: [UserRole.PATIENT],
};

export type ConsentInput = { kind: ConsentKind; version: number; accepted: boolean };

export type PublishConsentInput = {
  kind: ConsentKind;
  titleAr: string;
  titleEn?: string | null;
  bodyAr: string;
  bodyEn?: string | null;
  url?: string | null;
  roles?: UserRole[];
};

/**
 * Consent records (launch decision; Law 151/2020 — explicit consent for health data). The wording is
 * pluggable: a super admin publishes each text as a numbered version (`consent_documents`, never edited),
 * and nothing is required until a kind has a published version. From then on sign-up must accept the
 * current versions for the role, and `GET /me/consents` tells the app when someone has to accept a newer
 * one. Every acceptance or withdrawal is an append-only `consent_records` row (user, kind, version, time, IP).
 */
@Service()
export class ConsentService {
  private readonly audit = Container.get(AuditService);

  /** The newest published version of each kind; with a role, only the kinds that role must accept. */
  async current(role?: UserRole, session?: ClientSession) {
    const rows = await ConsentDocumentModel.aggregate<{ doc: IConsentDocument }>([
      { $sort: { kind: 1, version: -1 } },
      { $group: { _id: '$kind', doc: { $first: '$$ROOT' } } },
    ]).session(session ?? null);
    return rows
      .map((r) => r.doc)
      .filter((d) => !role || d.roles.includes(role))
      .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  }

  /** Per current text for the user's role: which version they accepted (if any) and whether it is current. */
  async status(userId: string, role: UserRole) {
    const [docs, latest] = await Promise.all([
      this.current(role),
      ConsentRecordModel.aggregate<{ _id: ConsentKind; record: IConsentRecord }>([
        { $match: { userId: new Types.ObjectId(userId) } },
        { $sort: { createdAt: -1, _id: -1 } },
        { $group: { _id: '$kind', record: { $first: '$$ROOT' } } },
      ]),
    ]);
    const byKind = new Map(latest.map((r) => [r._id, r.record]));
    return docs.map((document) => {
      const last = byKind.get(document.kind);
      const accepted = last?.action === ConsentAction.ACCEPTED ? last : null;
      return {
        document,
        acceptedVersion: accepted?.version ?? null,
        acceptedAt: accepted?.createdAt ?? null,
        withdrawnAt: last?.action === ConsentAction.WITHDRAWN ? last.createdAt : null,
        upToDate: accepted?.version === document.version,
      };
    });
  }

  /** Records acceptances / withdrawals of the current versions (an older version → 409: show the new text). */
  async record(
    userId: Types.ObjectId | string,
    items: ConsentInput[],
    ip: string | null,
    session?: ClientSession,
  ) {
    const docs = await this.current(undefined, session);
    const rows = items.map((item, i) => {
      const doc = docs.find((d) => d.kind === item.kind);
      if (!doc) throw new ValidationError({ [`consents.${i}.kind`]: ['validation.consent_unknown'] });
      if (doc.version !== item.version) throw new ConflictError('errors.consent_outdated');
      return {
        userId: new Types.ObjectId(String(userId)),
        kind: doc.kind,
        version: doc.version,
        documentId: doc._id,
        action: item.accepted ? ConsentAction.ACCEPTED : ConsentAction.WITHDRAWN,
        ip,
      };
    });
    if (rows.length) await ConsentRecordModel.insertMany(rows, { session });
  }

  /** Inside the registration transaction: every current text for the role must be accepted. */
  async acceptAtSignup(
    session: ClientSession,
    user: { _id: Types.ObjectId; role: UserRole },
    items: Array<{ kind: ConsentKind; version: number }> | undefined,
    ip: string | null,
  ) {
    const required = await this.current(user.role, session);
    const given = items ?? [];
    if (required.some((d) => !given.some((g) => g.kind === d.kind))) {
      throw new ValidationError({ consents: ['validation.consent_required'] });
    }
    await this.record(
      user._id,
      given.map((g) => ({ ...g, accepted: true })),
      ip,
      session,
    );
  }

  // ── Admin (super admin): publish a new version; list all versions ──

  async publish(input: PublishConsentInput, context: AuditContext) {
    const last = await ConsentDocumentModel.findOne({ kind: input.kind }).sort({ version: -1 }).lean();
    const doc = await ConsentDocumentModel.create({
      kind: input.kind,
      version: (last?.version ?? 0) + 1,
      titleAr: input.titleAr,
      titleEn: input.titleEn ?? null,
      bodyAr: input.bodyAr,
      bodyEn: input.bodyEn ?? null,
      url: input.url ?? null,
      roles: input.roles?.length ? input.roles : DEFAULT_CONSENT_ROLES[input.kind],
      publishedBy: context.actorId,
    });
    await this.audit.log(context, {
      action: 'consent_document.publish',
      entityType: 'consent_document',
      entityId: String(doc._id),
      metadata: { kind: doc.kind, version: doc.version, roles: doc.roles },
    });
    return doc.toObject();
  }

  listDocuments() {
    return ConsentDocumentModel.find().sort({ kind: 1, version: -1 }).lean();
  }
}
