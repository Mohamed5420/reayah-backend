import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { Container } from 'typedi';
import type { ZodType } from 'zod';
import type IBaseController from '../interfaces/base-controller.interface';
import { CheckAppStatusMiddleware } from '../../middlewares/app';
import { Auth } from '../../middlewares/auth';
import { PatientSchemas } from '../../validations/patient/patient.validation';
import { AftercareSchemas } from '../../validations/aftercare/aftercare.validation';
import { parseDateOnly } from '../../validations/auth/auth.validation';
import { z } from '../../validations/zod';
import {
  presentAllergy,
  presentCondition,
  presentDocument,
  presentMedication,
  presentProfile,
} from '../../presenters/patient.presenter';
import { presentVisitReport, presentVisitReportItem } from '../../presenters/aftercare.presenter';
import { defineRoute, type DefinedRoute } from '../../../docs/openapi';
import {
  MedicalDocumentService,
  MedicalRecordService,
  PatientProfileService,
  type PatientProfileInput,
} from '../../../services/patient';
import { auditContextFrom } from '../../../services/audit';
import { VisitReportService } from '../../../services/aftercare';
import { UserRole } from '../../../interfaces/enums';
import { HttpResponse } from '../../../utils/response/http-response';
import { camelizeKeys } from '../../../utils/case';
import { ConsentService } from '../../../services/consent';
import { resolveLanguage, t } from '../../../utils/i18n';

const tags = ['Patient — Profiles & medical'];
const auth = true;

const profileRoutes = {
  list: defineRoute({
    method: 'get',
    path: '/patient-profiles',
    summary: 'Me + family members',
    tags,
    auth,
    response: { schema: z.array(PatientSchemas.profile) },
  }),
  create: defineRoute({
    method: 'post',
    path: '/patient-profiles',
    summary: 'Add a family member',
    tags,
    auth,
    request: { body: PatientSchemas.createProfileBody },
    response: { status: 201, schema: PatientSchemas.profile },
  }),
  get: defineRoute({
    method: 'get',
    path: '/patient-profiles/:id',
    summary: 'Full profile with medical summary (audited)',
    tags,
    auth,
    request: { params: PatientSchemas.idParams },
    response: { schema: PatientSchemas.profileDetail },
  }),
  update: defineRoute({
    method: 'patch',
    path: '/patient-profiles/:id',
    summary: 'Update a profile (the "self" relation can’t change)',
    tags,
    auth,
    request: { params: PatientSchemas.idParams, body: PatientSchemas.updateProfileBody },
    response: { schema: PatientSchemas.profile },
  }),
  remove: defineRoute({
    method: 'delete',
    path: '/patient-profiles/:id',
    summary: 'Delete a family member (not "self")',
    tags,
    auth,
    request: { params: PatientSchemas.idParams },
    response: { status: 204 },
  }),
};

const documentRoutes = {
  list: defineRoute({
    method: 'get',
    path: '/patient-profiles/:id/documents',
    summary: 'Medical documents with 10-minute signed URLs (audited)',
    tags,
    auth,
    request: { params: PatientSchemas.idParams },
    response: { schema: z.array(PatientSchemas.document) },
  }),
  attach: defineRoute({
    method: 'post',
    path: '/patient-profiles/:id/documents',
    summary: 'Attach a file uploaded via POST /uploads (purpose: medical_document)',
    tags,
    auth,
    request: { params: PatientSchemas.idParams, body: PatientSchemas.attachDocumentBody },
    response: { status: 201, schema: PatientSchemas.document },
  }),
  remove: defineRoute({
    method: 'delete',
    path: '/patient-profiles/:id/documents/:record_id',
    summary: 'Delete a medical document and its file',
    tags,
    auth,
    request: { params: PatientSchemas.recordParams },
    response: { status: 204 },
  }),
};

const reportRoutes = {
  list: defineRoute({
    method: 'get',
    path: '/patient-profiles/:id/visit-reports',
    summary: 'Reports written by providers after visits, newest first (audited)',
    tags,
    auth,
    request: { params: PatientSchemas.idParams },
    response: { schema: z.array(AftercareSchemas.visitReportItem) },
  }),
  get: defineRoute({
    method: 'get',
    path: '/patient-profiles/:id/visit-reports/:rid',
    summary:
      'Report details: vitals, procedures, recommendations, attachments (10-minute signed URLs; audited)',
    tags,
    auth,
    request: { params: AftercareSchemas.reportParams },
    response: { schema: AftercareSchemas.visitReport },
  }),
};

type RecordKind = 'conditions' | 'medications' | 'allergies';

/** Same four routes for each kind of medical record (spec §7.6). */
const recordRoutes = (kind: RecordKind, label: string, body: ZodType, patch: ZodType, schema: ZodType) => ({
  list: defineRoute({
    method: 'get',
    path: `/patient-profiles/:id/${kind}`,
    summary: `List ${label} (audited)`,
    tags,
    auth,
    request: { params: PatientSchemas.idParams },
    response: { schema: z.array(schema) },
  }),
  create: defineRoute({
    method: 'post',
    path: `/patient-profiles/:id/${kind}`,
    summary: `Add ${label}`,
    tags,
    auth,
    request: { params: PatientSchemas.idParams, body },
    response: { status: 201, schema },
  }),
  update: defineRoute({
    method: 'patch',
    path: `/patient-profiles/:id/${kind}/:record_id`,
    summary: `Update ${label}`,
    tags,
    auth,
    request: { params: PatientSchemas.recordParams, body: patch },
    response: { schema },
  }),
  remove: defineRoute({
    method: 'delete',
    path: `/patient-profiles/:id/${kind}/:record_id`,
    summary: `Delete ${label}`,
    tags,
    auth,
    request: { params: PatientSchemas.recordParams },
    response: { status: 204 },
  }),
});

const records = {
  conditions: {
    routes: recordRoutes(
      'conditions',
      'a chronic condition',
      PatientSchemas.conditionBody,
      PatientSchemas.conditionPatch,
      PatientSchemas.condition,
    ),
    present: presentCondition,
  },
  medications: {
    routes: recordRoutes(
      'medications',
      'a medication',
      PatientSchemas.medicationBody,
      PatientSchemas.medicationPatch,
      PatientSchemas.medication,
    ),
    present: presentMedication,
  },
  allergies: {
    routes: recordRoutes(
      'allergies',
      'an allergy',
      PatientSchemas.allergyBody,
      PatientSchemas.allergyPatch,
      PatientSchemas.allergy,
    ),
    present: presentAllergy,
  },
};

/**
 * Patient profiles and medical records (spec §7.6). Patients only; every route first checks that the
 * profile belongs to the caller (404 otherwise). Medical reads and writes are audited (spec §9).
 */
export default class PatientProfileController implements IBaseController {
  path = '/patient-profiles';
  router = Router();

  private profiles = Container.get(PatientProfileService);
  private medical = Container.get(MedicalRecordService);
  private documents = Container.get(MedicalDocumentService);
  private reports = Container.get(VisitReportService);
  private consents = Container.get(ConsentService);

  constructor() {
    this.initializeRoutes();
  }

  initializeRoutes() {
    this.mount(profileRoutes.list, this.listProfiles);
    this.mount(profileRoutes.create, this.createProfile);
    this.mount(profileRoutes.get, this.getProfile);
    this.mount(profileRoutes.update, this.updateProfile);
    this.mount(profileRoutes.remove, this.removeProfile);

    for (const kind of Object.keys(records) as RecordKind[]) this.mountRecords(kind);

    this.mount(documentRoutes.list, this.listDocuments);
    this.mount(documentRoutes.attach, this.attachDocument);
    this.mount(documentRoutes.remove, this.removeDocument);

    this.mount(reportRoutes.list, this.listReports);
    this.mount(reportRoutes.get, this.getReport);
  }

  private mount(route: DefinedRoute, handler: RequestHandler) {
    this.router[route.method](
      route.path,
      CheckAppStatusMiddleware,
      route.validate,
      ...Auth(UserRole.PATIENT),
      handler.bind(this),
    );
  }

  // ── Profiles ──

  private async listProfiles(req: Request, res: Response, next: NextFunction) {
    try {
      const profiles = await this.profiles.list(req.user!.id);
      return HttpResponse.ok(res, profiles.map(presentProfile));
    } catch (err) {
      next(err);
    }
  }

  private async createProfile(req: Request, res: Response, next: NextFunction) {
    try {
      if (req.body.blood_type != null) await this.consents.assertHealthDataAllowed(req.user!.id);
      const profile = await this.profiles.create(
        req.user!.id,
        this.toProfileInput(req.body),
        auditContextFrom(req),
      );
      return HttpResponse.created(res, presentProfile(profile));
    } catch (err) {
      next(err);
    }
  }

  private async getProfile(req: Request, res: Response, next: NextFunction) {
    try {
      const profile = await this.profiles.getOwned(req.user!.id, req.params.id);
      const summary = await this.profiles.medicalSummary(req.params.id, auditContextFrom(req));
      return HttpResponse.ok(res, {
        ...presentProfile(profile),
        conditions: summary.conditions.map(presentCondition),
        medications: summary.medications.map(presentMedication),
        allergies: summary.allergies.map(presentAllergy),
        documents_count: summary.documentsCount,
        visit_reports_count: await this.reports.countForProfile(req.params.id),
        ...(await this.healthDataState(req)),
      });
    } catch (err) {
      next(err);
    }
  }

  private async updateProfile(req: Request, res: Response, next: NextFunction) {
    try {
      if ('blood_type' in req.body) await this.consents.assertHealthDataAllowed(req.user!.id);
      const profile = await this.profiles.update(
        req.user!.id,
        req.params.id,
        this.toProfileInput(req.body),
        auditContextFrom(req),
      );
      return HttpResponse.ok(res, presentProfile(profile));
    } catch (err) {
      next(err);
    }
  }

  private async removeProfile(req: Request, res: Response, next: NextFunction) {
    try {
      await this.profiles.remove(req.user!.id, req.params.id);
      return HttpResponse.noContent(res);
    } catch (err) {
      next(err);
    }
  }

  private toProfileInput(body: Partial<z.infer<typeof PatientSchemas.createProfileBody>>) {
    const { date_of_birth, ...rest } = body;
    return {
      ...camelizeKeys(rest),
      ...(date_of_birth ? { dateOfBirth: parseDateOnly(date_of_birth) } : {}),
    } as PatientProfileInput;
  }

  /** Interim rule (ConsentService): paused health data is shown read-only, with the notice. */
  private async healthDataState(req: Request) {
    const paused = await this.consents.healthDataPaused(req.user!.id);
    return {
      health_data_paused: paused,
      health_data_notice: paused
        ? t('consent_notice.health_data_paused', undefined, resolveLanguage(req))
        : null,
    };
  }

  // ── Medical records ──

  private mountRecords(kind: RecordKind) {
    const { routes, present } = records[kind];
    const service = this.medical[kind];
    const present_ = present as (record: never) => unknown;

    this.mount(routes.list, async (req, res, next) => {
      try {
        await this.profiles.getOwned(req.user!.id, req.params.id);
        const list = await service.list(req.params.id, auditContextFrom(req));
        return HttpResponse.ok(
          res,
          list.map((r) => present_(r as never)),
        );
      } catch (err) {
        next(err);
      }
    });

    this.mount(routes.create, async (req, res, next) => {
      try {
        await this.profiles.getOwned(req.user!.id, req.params.id);
        await this.consents.assertHealthDataAllowed(req.user!.id);
        const record = await service.create(req.params.id, camelizeKeys(req.body), auditContextFrom(req));
        return HttpResponse.created(res, present_(record as never));
      } catch (err) {
        next(err);
      }
    });

    this.mount(routes.update, async (req, res, next) => {
      try {
        await this.profiles.getOwned(req.user!.id, req.params.id);
        await this.consents.assertHealthDataAllowed(req.user!.id);
        const record = await service.update(
          req.params.id,
          req.params.record_id,
          camelizeKeys(req.body),
          auditContextFrom(req),
        );
        return HttpResponse.ok(res, present_(record as never));
      } catch (err) {
        next(err);
      }
    });

    this.mount(routes.remove, async (req, res, next) => {
      try {
        await this.profiles.getOwned(req.user!.id, req.params.id);
        await this.consents.assertHealthDataAllowed(req.user!.id);
        await service.remove(req.params.id, req.params.record_id, auditContextFrom(req));
        return HttpResponse.noContent(res);
      } catch (err) {
        next(err);
      }
    });
  }

  // ── Documents ──

  private async listDocuments(req: Request, res: Response, next: NextFunction) {
    try {
      await this.profiles.getOwned(req.user!.id, req.params.id);
      const documents = await this.documents.list(req.params.id, auditContextFrom(req));
      return HttpResponse.ok(
        res,
        documents.map(({ document, fileUrl }) => presentDocument(document, fileUrl)),
      );
    } catch (err) {
      next(err);
    }
  }

  private async attachDocument(req: Request, res: Response, next: NextFunction) {
    try {
      await this.profiles.getOwned(req.user!.id, req.params.id);
      await this.consents.assertHealthDataAllowed(req.user!.id);
      const body = req.body as z.infer<typeof PatientSchemas.attachDocumentBody>;
      const { document, fileUrl } = await this.documents.attach(
        req.user!.id,
        req.params.id,
        { fileKey: body.file_key, type: body.type, title: body.title },
        auditContextFrom(req),
      );
      return HttpResponse.created(res, presentDocument(document, fileUrl));
    } catch (err) {
      next(err);
    }
  }

  private async removeDocument(req: Request, res: Response, next: NextFunction) {
    try {
      await this.profiles.getOwned(req.user!.id, req.params.id);
      await this.consents.assertHealthDataAllowed(req.user!.id);
      await this.documents.remove(req.params.id, req.params.record_id, auditContextFrom(req));
      return HttpResponse.noContent(res);
    } catch (err) {
      next(err);
    }
  }

  // ── Visit reports ──

  private async listReports(req: Request, res: Response, next: NextFunction) {
    try {
      await this.profiles.getOwned(req.user!.id, req.params.id);
      const reports = await this.reports.listForProfile(req.params.id, auditContextFrom(req));
      return HttpResponse.ok(
        res,
        reports.map(({ report, provider }) => presentVisitReportItem(report, provider)),
      );
    } catch (err) {
      next(err);
    }
  }

  private async getReport(req: Request, res: Response, next: NextFunction) {
    try {
      await this.profiles.getOwned(req.user!.id, req.params.id);
      const d = await this.reports.getForProfile(req.params.id, req.params.rid, auditContextFrom(req));
      return HttpResponse.ok(res, presentVisitReport(d.report, d.provider, d.attachments));
    } catch (err) {
      next(err);
    }
  }
}
