import type { Request } from 'express';
import type { Document } from 'mongoose';
import { Service } from 'typedi';
import { AuditLogModel } from '../../database/models/audit-log/audit-log.model';
import type { Pagination } from '../../utils/response/pagination';

/** Who did it and from where. `actorId: null` = the system. */
export type AuditContext = { actorId: string | null; ip?: string };

export type AuditEntry = {
  action: string;
  entityType: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
};

export const auditContextFrom = (req: Request): AuditContext => ({
  actorId: req.user?.id ?? null,
  ip: req.ip,
});

export const SYSTEM_AUDIT_CONTEXT: AuditContext = { actorId: null };

export type FieldChanges = Record<string, { from: unknown; to: unknown }>;

/**
 * Applies a patch (model field names) to a document and returns only the fields that actually
 * changed, as `{ field: { from, to } }` — ready to put in an audit entry's metadata. Doesn't save.
 */
export const applyPatch = (doc: Document, patch: Record<string, unknown>): FieldChanges => {
  const changes: FieldChanges = {};
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const before: unknown = doc.get(field);
    // JSON comparison treats an ObjectId and its hex string as equal.
    if (JSON.stringify(before ?? null) === JSON.stringify(value)) continue;
    changes[field] = { from: before ?? null, to: value };
    doc.set(field, value);
  }
  return changes;
};

/**
 * Writes `audit_logs` entries for every admin write and every medical-data read (spec §7.15, §9).
 * Awaited on purpose: if the audit entry can't be written, the action fails instead of going unrecorded.
 */
@Service()
export class AuditService {
  async log(context: AuditContext, entry: AuditEntry) {
    await AuditLogModel.create({
      actorId: context.actorId,
      ip: context.ip ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      metadata: entry.metadata ?? null,
    });
  }

  /** GET /admin/audit-logs — newest first. */
  async list(
    filters: { actorId?: string; entityType?: string; entityId?: string; action?: string },
    pagination: Pagination,
  ) {
    const query = {
      ...(filters.actorId ? { actorId: filters.actorId } : {}),
      ...(filters.entityType ? { entityType: filters.entityType } : {}),
      ...(filters.entityId ? { entityId: filters.entityId } : {}),
      ...(filters.action ? { action: filters.action } : {}),
    };
    const [data, total] = await Promise.all([
      AuditLogModel.find(query)
        .sort({ createdAt: -1 })
        .skip(pagination.skip)
        .limit(pagination.perPage)
        .lean(),
      AuditLogModel.countDocuments(query),
    ]);
    return { data, total };
  }
}
