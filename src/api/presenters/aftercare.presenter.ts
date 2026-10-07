import type { IDispute, IReview } from '../../interfaces/IAftercare';
import type { VisitReportView } from '../../services/aftercare/visit-report.service';
import type { ProviderType } from '../../interfaces/enums';

/** Maps reviews, disputes and visit reports to the API shapes in aftercare.validation.ts. */

type ReportProvider = { id: string; name: string; type: ProviderType | null } | null;

/** Public review (GET /providers/{id}/reviews, `recent_reviews`): reviewer by first name + initial only. */
export const presentPublicReview = ({ review, patientName }: { review: IReview; patientName: string }) => ({
  rating: review.rating,
  comment: review.comment,
  patient_name: patientName,
  date: review.createdAt.toISOString(),
});

export const presentReview = (review: IReview) => ({
  id: String(review._id),
  booking_id: String(review.bookingId),
  rating: review.rating,
  comment: review.comment,
  tags: review.tags,
  created_at: review.createdAt.toISOString(),
});

export const presentProviderReview = ({ review, patientName }: { review: IReview; patientName: string }) => ({
  id: String(review._id),
  booking_id: String(review.bookingId),
  rating: review.rating,
  comment: review.comment,
  tags: review.tags,
  patient_name: patientName,
  date: review.createdAt.toISOString(),
});

export const presentAdminReview = ({ review, patientName }: { review: IReview; patientName: string }) => ({
  id: String(review._id),
  booking_id: String(review.bookingId),
  provider_profile_id: String(review.providerProfileId),
  patient_user_id: String(review.patientUserId),
  patient_name: patientName,
  rating: review.rating,
  comment: review.comment,
  original_comment: review.originalComment,
  tags: review.tags,
  is_visible: review.isVisible,
  flagged: review.flagged,
  created_at: review.createdAt.toISOString(),
});

export const presentDispute = (d: IDispute) => ({
  id: String(d._id),
  booking_id: String(d.bookingId),
  status: d.status,
  reason_code: d.reasonCode,
  description: d.description,
  created_at: d.createdAt.toISOString(),
});

export const presentAdminDispute = (
  d: IDispute,
  bookingReference: string | null,
  attachmentUrls: string[],
) => ({
  ...presentDispute(d),
  booking_reference: bookingReference,
  patient_user_id: String(d.patientUserId),
  provider_profile_id: d.providerProfileId ? String(d.providerProfileId) : null,
  attachments: attachmentUrls.map((url) => ({ file_url: url })),
  resolution: d.resolution
    ? {
        type: d.resolution.type,
        refund_amount: d.resolution.refundAmount,
        provider_action: d.resolution.providerAction,
        suspend_days: d.resolution.suspendDays,
        message_to_patient: d.resolution.messageToPatient,
        message_to_provider: d.resolution.messageToProvider,
        resolved_by: String(d.resolution.resolvedBy),
        resolved_at: d.resolution.resolvedAt.toISOString(),
      }
    : null,
});

export const presentVisitReportItem = (report: VisitReportView, provider: ReportProvider) => ({
  id: String(report._id),
  booking_id: String(report.bookingId),
  date: report.createdAt.toISOString(),
  provider,
  summary: report.summary,
});

export const presentVisitReport = (
  report: VisitReportView,
  provider: ReportProvider,
  attachments: Array<{ fileUrl: string; mime: string }>,
) => ({
  ...presentVisitReportItem(report, provider),
  vitals: report.vitals,
  procedures_done: report.proceduresDone,
  recommendations: report.recommendations,
  attachments: attachments.map((a) => ({ file_url: a.fileUrl, mime: a.mime })),
});
