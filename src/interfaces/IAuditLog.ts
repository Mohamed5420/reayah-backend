import type { Types } from 'mongoose';

/** Append-only record of an admin action or a sensitive read (spec §4.10 `audit_logs`, §9). */
export interface IAuditLog {
  _id: Types.ObjectId;
  /** null for actions taken by the system (jobs). */
  actorId: Types.ObjectId | null;
  /** `<entity>.<verb>`, e.g. `settings.update`, `provider.approve`, `medical_profile.read`. */
  action: string;
  entityType: string;
  entityId: string | null;
  metadata: Record<string, unknown> | null;
  ip: string | null;
  createdAt: Date;
}
