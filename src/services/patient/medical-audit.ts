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

/** A booking's patient notes were shown (they may describe the patient's condition). */
export const auditNotesRead = (context: AuditContext, booking: { _id: unknown; patientProfileId: unknown }) =>
  Container.get(AuditService).log(context, {
    action: 'booking_notes.read',
    entityType: 'booking',
    entityId: String(booking._id),
    metadata: { patientProfileId: String(booking.patientProfileId) },
  });

/** A dispute's description was shown (it may describe health details). */
export const auditDisputeRead = (context: AuditContext, disputeId: string) =>
  Container.get(AuditService).log(context, {
    action: 'dispute.read',
    entityType: 'dispute',
    entityId: disputeId,
  });
