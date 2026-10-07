import { Container, Service } from 'typedi';
import { Types, type HydratedDocument } from 'mongoose';
import { BookingModel } from '../../database/models/booking/booking.model';
import { VisitReportModel } from '../../database/models/aftercare/aftercare.models';
import { ProviderProfileModel } from '../../database/models/provider/provider-profile.model';
import { UserModel } from '../../database/models/user/user.model';
import { BookingStatus } from '../../interfaces/IBooking';
import type { IVisitReport, Vitals } from '../../interfaces/IAftercare';
import type { IProviderProfile } from '../../interfaces/IProfiles';
import { NotificationType } from '../../interfaces/INotification';
import { ConflictError, NotFoundError } from '../../utils/types-errors';
import type { AuditContext } from '../audit/audit.service';
import { bookingParams } from '../notification/booking-notifications';
import { NotificationService } from '../notification/notification.service';
import { auditMedical } from '../patient/medical-audit';
import { StorageService, mimeOfKey } from '../storage/storage.service';

/** Providers can correct a report for 24 hours after submitting it (spec §7.10). */
export const REPORT_EDIT_WINDOW_HOURS = 24;

export type VisitReportInput = {
  summary: string;
  vitals?: Vitals | null;
  proceduresDone?: string[];
  recommendations?: string | null;
  /** Keys from POST /uploads (purpose `visit_report`), or keys already on the report (when editing). */
  attachments?: string[];
};

/** Decrypted, parsed report. */
export type VisitReportView = Omit<IVisitReport, 'vitalsData' | 'proceduresData'> & {
  vitals: Vitals | null;
  proceduresDone: string[];
};

const toView = (doc: HydratedDocument<IVisitReport>): VisitReportView => {
  const plain = doc.toObject() as IVisitReport; // getters decrypt
  const { vitalsData, proceduresData, ...rest } = plain;
  return {
    ...rest,
    vitals: vitalsData ? (JSON.parse(vitalsData) as Vitals) : null,
    proceduresDone: proceduresData ? (JSON.parse(proceduresData) as string[]) : [],
  };
};

/**
 * Visit reports (spec §4.6, §7.6, §7.10). Written by the assigned provider once the visit has started;
 * become part of the patient's medical record. Medical text is encrypted; patient reads are audited.
 */
@Service()
export class VisitReportService {
  private readonly storage = Container.get(StorageService);
  private readonly notifications = Container.get(NotificationService);

  async submit(
    profile: Pick<IProviderProfile, '_id'>,
    bookingId: string,
    userId: string,
    input: VisitReportInput,
  ) {
    const booking = await this.assignedBooking(profile, bookingId);
    if (![BookingStatus.IN_PROGRESS, BookingStatus.COMPLETED].includes(booking.status)) {
      throw new ConflictError('errors.report_not_allowed');
    }
    if (await VisitReportModel.exists({ bookingId: booking._id }))
      throw new ConflictError('errors.report_exists');

    const attachmentKeys = await this.resolveAttachments(userId, bookingId, input.attachments ?? [], []);
    const report = await VisitReportModel.create({
      bookingId: booking._id,
      providerProfileId: profile._id,
      patientProfileId: booking.patientProfileId,
      summary: input.summary,
      vitalsData: input.vitals ? JSON.stringify(input.vitals) : null,
      proceduresData: input.proceduresDone?.length ? JSON.stringify(input.proceduresDone) : null,
      recommendations: input.recommendations ?? null,
      attachmentKeys,
    });
    await this.notifications.notify([booking.patientUserId], {
      type: NotificationType.VISIT_REPORT,
      template: 'visit_report_ready',
      params: await bookingParams(booking),
      data: {
        booking_id: String(booking._id),
        report_id: String(report._id),
        patient_profile_id: String(booking.patientProfileId),
      },
    });
    return toView(report);
  }

  async update(
    profile: Pick<IProviderProfile, '_id'>,
    bookingId: string,
    userId: string,
    patch: Partial<VisitReportInput>,
  ) {
    const booking = await this.assignedBooking(profile, bookingId);
    const report = await VisitReportModel.findOne({ bookingId: booking._id });
    if (!report) throw new NotFoundError('errors.report_not_found');
    if (Date.now() - report.createdAt.getTime() > REPORT_EDIT_WINDOW_HOURS * 3600_000) {
      throw new ConflictError('errors.report_edit_window');
    }
    if (patch.summary !== undefined) report.summary = patch.summary;
    if (patch.vitals !== undefined) report.vitalsData = patch.vitals ? JSON.stringify(patch.vitals) : null;
    if (patch.proceduresDone !== undefined) {
      report.proceduresData = patch.proceduresDone.length ? JSON.stringify(patch.proceduresDone) : null;
    }
    if (patch.recommendations !== undefined) report.recommendations = patch.recommendations;
    if (patch.attachments !== undefined) {
      report.attachmentKeys = await this.resolveAttachments(
        userId,
        bookingId,
        patch.attachments,
        report.attachmentKeys,
      );
    }
    await report.save();
    return toView(report);
  }

  /** The report id for a booking, for booking details (`visit_report_id`). */
  async idForBooking(bookingId: Types.ObjectId | string) {
    const report = await VisitReportModel.findOne({ bookingId }).select('_id').lean();
    return report ? String(report._id) : null;
  }

  countForProfile(patientProfileId: string) {
    return VisitReportModel.countDocuments({ patientProfileId });
  }

  /** GET /patient-profiles/{id}/visit-reports — newest first. Audited (medical read). */
  async listForProfile(patientProfileId: string, context: AuditContext) {
    const reports = await VisitReportModel.find({ patientProfileId }).sort({ createdAt: -1 });
    await auditMedical(context, 'medical_profile.read', patientProfileId, { section: 'visit_reports' });
    const providers = await this.providerNames(reports.map((r) => r.providerProfileId));
    return reports.map((report) => ({
      report: toView(report),
      provider: providers.get(String(report.providerProfileId)) ?? null,
    }));
  }

  /** One report with signed attachment URLs. Audited (medical read). */
  async getForProfile(patientProfileId: string, reportId: string, context: AuditContext) {
    const report = Types.ObjectId.isValid(reportId)
      ? await VisitReportModel.findOne({ _id: reportId, patientProfileId })
      : null;
    if (!report) throw new NotFoundError('errors.report_not_found');
    await auditMedical(context, 'medical_profile.read', patientProfileId, {
      section: 'visit_reports',
      reportId,
    });
    const providers = await this.providerNames([report.providerProfileId]);
    return {
      report: toView(report),
      provider: providers.get(String(report.providerProfileId)) ?? null,
      attachments: await this.attachmentsOf(report.attachmentKeys),
    };
  }

  /** A report as its author sees it after submit / edit. */
  async withDetails(report: VisitReportView) {
    const providers = await this.providerNames([report.providerProfileId]);
    return {
      report,
      provider: providers.get(String(report.providerProfileId)) ?? null,
      attachments: await this.attachmentsOf(report.attachmentKeys),
    };
  }

  private attachmentsOf(keys: string[]) {
    return Promise.all(
      keys.map(async (key) => ({ fileUrl: await this.storage.signedUrl(key), mime: mimeOfKey(key) })),
    );
  }

  private async assignedBooking(profile: Pick<IProviderProfile, '_id'>, bookingId: string) {
    const booking = Types.ObjectId.isValid(bookingId)
      ? await BookingModel.findOne({ _id: bookingId, providerProfileId: profile._id }).lean()
      : null;
    if (!booking) throw new NotFoundError('errors.booking_not_found');
    return booking;
  }

  /** Temp uploads are moved under the booking; keys already on the report are kept as they are. */
  private async resolveAttachments(userId: string, bookingId: string, keys: string[], existing: string[]) {
    return Promise.all(
      keys.map((key) =>
        existing.includes(key)
          ? Promise.resolve(key)
          : this.storage.promote(key, {
              ownerId: userId,
              purpose: 'visit_report',
              destPrefix: `visit-reports/${bookingId}`,
            }),
      ),
    );
  }

  private async providerNames(ids: Types.ObjectId[]) {
    const profiles = await ProviderProfileModel.find({ _id: { $in: ids } })
      .select('userId type')
      .setOptions({ withDeleted: true })
      .lean();
    const users = await UserModel.find({ _id: { $in: profiles.map((p) => p.userId) } })
      .select('fullName')
      .setOptions({ withDeleted: true })
      .lean();
    const nameById = new Map(users.map((u) => [String(u._id), u.fullName]));
    return new Map(
      profiles.map((p) => [
        String(p._id),
        { id: String(p._id), name: nameById.get(String(p.userId)) ?? '', type: p.type },
      ]),
    );
  }
}
