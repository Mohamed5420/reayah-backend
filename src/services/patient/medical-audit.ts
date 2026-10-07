import { Container } from 'typedi';
import { AuditService, type AuditContext } from '../audit/audit.service';

/**
 * Spec §9: every access to medical data is audited. Entries name the profile and what was touched —
 * never the medical values themselves (the audit log is not encrypted).
 */
export const auditMedical = (
  context: AuditContext,
  action: string,
  patientProfileId: string,
  metadata: Record<string, unknown> = {},
) =>
  Container.get(AuditService).log(context, {
    action,
    entityType: 'patient_profile',
    entityId: patientProfileId,
    metadata,
  });
