import { Router, type NextFunction, type Request, type Response } from 'express';
import { Container } from 'typedi';
import type IBaseController from '../interfaces/base-controller.interface';
import { CheckAppStatusMiddleware } from '../../middlewares/app';
import { Auth } from '../../middlewares/auth';
import { ClinicSchemas } from '../../validations/clinic/clinic.validation';
import type { z } from '../../validations/zod';
import { presentClinic } from '../../presenters/clinic.presenter';
import { defineRoute, type DefinedRoute } from '../../../docs/openapi';
import { ClinicService, type ClinicInput } from '../../../services/clinic';
import { ProviderProfileService } from '../../../services/provider';
import { LocationService } from '../../../services/location';
import { StorageService } from '../../../services/storage';
import { UserRole } from '../../../interfaces/enums';
import type { IClinic, IProviderClinic } from '../../../interfaces/IClinic';
import { HttpResponse } from '../../../utils/response/http-response';
import { resolveLanguage } from '../../../utils/i18n';
import { parseDateOnly } from '../../validations/auth/auth.validation';

const tags = ['Provider — Clinics'];
const auth = true;
const params = ClinicSchemas.idParams;

const r = {
  list: defineRoute({
    method: 'get',
    path: '/provider/clinics',
    summary: 'My clinics (independent doctors), with my hours and settings at each',
    tags,
    auth,
    response: { schema: ClinicSchemas.clinic.array() },
  }),
  create: defineRoute({
    method: 'post',
    path: '/provider/clinics',
    summary:
      'Add a clinic: text address only (no coordinates), clinic phone. Up to `max_clinics_per_doctor`. Starts as a draft: add the licence and hours, then submit for review.',
    tags,
    auth,
    request: { body: ClinicSchemas.createBody },
    response: { status: 201, schema: ClinicSchemas.clinic },
  }),
  update: defineRoute({
    method: 'patch',
    path: '/provider/clinics/:id',
    summary:
      'Edit a clinic or pause it (`is_active`). Changing the name or address of an approved clinic sends it back for review.',
    tags,
    auth,
    request: { params, body: ClinicSchemas.updateBody },
    response: { schema: ClinicSchemas.clinic },
  }),
  remove: defineRoute({
    method: 'delete',
    path: '/provider/clinics/:id',
    summary: 'Remove a clinic (and my hours there)',
    tags,
    auth,
    request: { params },
    response: { status: 204 },
  }),
  licence: defineRoute({
    method: 'put',
    path: '/provider/clinics/:id/licence',
    summary:
      'Attach the clinic licence (POST /uploads with purpose `clinic_licence` first). Replaces the previous one; an approved clinic goes back for review.',
    tags,
    auth,
    request: { params, body: ClinicSchemas.licenceBody },
    response: { schema: ClinicSchemas.clinic },
  }),
  submit: defineRoute({
    method: 'post',
    path: '/provider/clinics/:id/submit',
    summary: 'Send the clinic for review (needs a licence). Bookable only once approved.',
    tags,
    auth,
    request: { params },
    response: { schema: ClinicSchemas.clinic },
  }),
  schedule: defineRoute({
    method: 'put',
    path: '/provider/clinics/:id/schedule',
    summary:
      'My weekly hours at this clinic, appointment length and instant confirmation. Hours may not overlap my home-visit hours or another clinic’s.',
    tags,
    auth,
    request: { params, body: ClinicSchemas.scheduleBody },
    response: { schema: ClinicSchemas.clinic },
  }),
};

/** An independent doctor's clinics (clinic visits, C1). Branches of organizations: C4. */
export default class ProviderClinicController implements IBaseController {
  path = '/provider/clinics';
  router = Router();

  private clinics = Container.get(ClinicService);
  private profiles = Container.get(ProviderProfileService);
  private locations = Container.get(LocationService);
  private storage = Container.get(StorageService);

  constructor() {
    this.initializeRoutes();
  }

  initializeRoutes() {
    this.mount(r.list, async (req, res) => {
      const profile = await this.profiles.getOwn(req.user!.id);
      const rows = await this.clinics.listOwn(profile);
      return HttpResponse.ok(res, await this.present(req, rows));
    });
    this.mount(r.create, async (req, res) => {
      const profile = await this.profiles.getOwn(req.user!.id);
      const row = await this.clinics.create(
        profile,
        this.toInput(req.body as z.infer<typeof ClinicSchemas.createBody>),
      );
      return HttpResponse.created(res, (await this.present(req, [row]))[0]);
    });
    this.mount(r.update, async (req, res) => {
      const body = req.body as z.infer<typeof ClinicSchemas.updateBody>;
      const profile = await this.profiles.getOwn(req.user!.id);
      const row = await this.clinics.update(profile, req.params.id, {
        ...this.toInput(body),
        ...(body.is_active !== undefined ? { isActive: body.is_active } : {}),
      });
      return HttpResponse.ok(res, (await this.present(req, [row]))[0]);
    });
    this.mount(r.remove, async (req, res) => {
      await this.clinics.remove(await this.profiles.getOwn(req.user!.id), req.params.id);
      return HttpResponse.noContent(res);
    });
    this.mount(r.licence, async (req, res) => {
      const body = req.body as z.infer<typeof ClinicSchemas.licenceBody>;
      const profile = await this.profiles.getOwn(req.user!.id);
      const row = await this.clinics.attachLicence(req.user!.id, profile, req.params.id, {
        fileKey: body.file_key,
        expiresAt: body.expires_at ? parseDateOnly(body.expires_at) : null,
      });
      return HttpResponse.ok(res, (await this.present(req, [row]))[0]);
    });
    this.mount(r.submit, async (req, res) => {
      const row = await this.clinics.submit(await this.profiles.getOwn(req.user!.id), req.params.id);
      return HttpResponse.ok(res, (await this.present(req, [row]))[0]);
    });
    this.mount(r.schedule, async (req, res) => {
      const body = req.body as z.infer<typeof ClinicSchemas.scheduleBody>;
      const row = await this.clinics.setSchedule(await this.profiles.getOwn(req.user!.id), req.params.id, {
        slotMinutes: body.slot_minutes,
        instantConfirm: body.instant_confirm,
        hours: body.hours.map((h) => ({
          dayOfWeek: h.day_of_week,
          startTime: h.start_time,
          endTime: h.end_time,
        })),
      });
      return HttpResponse.ok(res, (await this.present(req, [row]))[0]);
    });
  }

  /** Only fields that were sent (PATCH), in the service's shape. */
  private toInput(body: Partial<z.infer<typeof ClinicSchemas.createBody>>): ClinicInput {
    const map: Record<string, unknown> = {
      name: body.name,
      governorateId: body.governorate_id,
      areaId: body.area_id,
      street: body.street,
      building: body.building,
      floor: body.floor,
      landmark: body.landmark,
      phone: body.phone,
    };
    return Object.fromEntries(Object.entries(map).filter(([, v]) => v !== undefined)) as ClinicInput;
  }

  private async present(req: Request, rows: Array<{ clinic: IClinic; link: IProviderClinic | null }>) {
    const places = await this.locations.describeAreas(rows.map((r) => String(r.clinic.areaId)));
    const lang = resolveLanguage(req);
    return Promise.all(
      rows.map(async (row) =>
        presentClinic(
          {
            ...row,
            licenceUrl: row.clinic.licence ? await this.storage.signedUrl(row.clinic.licence.fileKey) : null,
          },
          places,
          lang,
        ),
      ),
    );
  }

  private mount(route: DefinedRoute, handler: (req: Request, res: Response) => Promise<unknown>) {
    this.router[route.method](
      route.path,
      CheckAppStatusMiddleware,
      route.validate,
      ...Auth(UserRole.PROVIDER),
      (req: Request, res: Response, next: NextFunction) => {
        handler(req, res).catch(next);
      },
    );
  }
}
