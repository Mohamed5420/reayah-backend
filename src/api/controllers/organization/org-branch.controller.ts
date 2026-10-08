import { Router, type NextFunction, type Request, type Response } from 'express';
import { Container } from 'typedi';
import type IBaseController from '../interfaces/base-controller.interface';
import { CheckAppStatusMiddleware } from '../../middlewares/app';
import { Auth } from '../../middlewares/auth';
import { ClinicSchemas } from '../../validations/clinic/clinic.validation';
import { objectId, z } from '../../validations/zod';
import { presentClinic } from '../../presenters/clinic.presenter';
import { presentAvailability } from '../../presenters/provider.presenter';
import { defineRoute, type DefinedRoute } from '../../../docs/openapi';
import { BranchService, type ClinicInput } from '../../../services/clinic';
import { OrganizationService } from '../../../services/organization';
import { LocationService } from '../../../services/location';
import { StorageService } from '../../../services/storage';
import { UserRole } from '../../../interfaces/enums';
import type { IClinic, IProviderClinic } from '../../../interfaces/IClinic';
import type { Types } from 'mongoose';
import { HttpResponse } from '../../../utils/response/http-response';
import { resolveLanguage } from '../../../utils/i18n';
import { parseDateOnly } from '../../validations/auth/auth.validation';

const tags = ['Organization — Branches'];
const auth = true;
const params = ClinicSchemas.idParams;
const doctorParams = z.object({ id: objectId, staffId: objectId });

const branch = ClinicSchemas.clinic
  .omit({ schedule: true })
  .extend({
    /** Staff doctors placed at this branch, with their hours there. */
    doctors: z.array(
      z.object({
        staff_id: z.string(),
        name: z.string(),
        appointment_minutes: z.number().nullable(),
        hours: z.array(z.object({ day_of_week: z.number(), start_time: z.string(), end_time: z.string() })),
      }),
    ),
  })
  .openapi('Branch');

const r = {
  list: defineRoute({
    method: 'get',
    path: '/org/branches',
    summary: 'My branches (clinics) with the doctors placed at each',
    tags,
    auth,
    response: { schema: branch.array() },
  }),
  create: defineRoute({
    method: 'post',
    path: '/org/branches',
    summary:
      'Add a branch: text address only (no coordinates), branch phone. Draft until its licence is attached and it is submitted for review.',
    tags,
    auth,
    request: { body: ClinicSchemas.createBody },
    response: { status: 201, schema: branch },
  }),
  update: defineRoute({
    method: 'patch',
    path: '/org/branches/:id',
    summary:
      'Edit or pause a branch. Changing the name or address of an approved branch sends it back for review.',
    tags,
    auth,
    request: { params, body: ClinicSchemas.updateBody },
    response: { schema: branch },
  }),
  remove: defineRoute({
    method: 'delete',
    path: '/org/branches/:id',
    summary: 'Remove a branch (and every doctor’s hours there)',
    tags,
    auth,
    request: { params },
    response: { status: 204 },
  }),
  licence: defineRoute({
    method: 'put',
    path: '/org/branches/:id/licence',
    summary: 'Attach the branch licence (POST /uploads with purpose `clinic_licence` first)',
    tags,
    auth,
    request: { params, body: ClinicSchemas.licenceBody },
    response: { schema: branch },
  }),
  submit: defineRoute({
    method: 'post',
    path: '/org/branches/:id/submit',
    summary: 'Send the branch for review (needs a licence). Bookable only once approved.',
    tags,
    auth,
    request: { params },
    response: { schema: branch },
  }),
  setDoctor: defineRoute({
    method: 'put',
    path: '/org/branches/:id/doctors/:staffId',
    summary:
      'Place a staff doctor at the branch with weekly hours there (replaces them). Hours may not overlap the doctor’s home-visit hours or another branch’s.',
    tags,
    auth,
    request: {
      params: doctorParams,
      body: z.strictObject({
        slot_minutes: z.number().int().min(5).max(240).nullable().default(null),
        hours: ClinicSchemas.scheduleBody.shape.hours,
      }),
    },
    response: { schema: branch },
  }),
  removeDoctor: defineRoute({
    method: 'delete',
    path: '/org/branches/:id/doctors/:staffId',
    summary: 'Take a doctor off the branch',
    tags,
    auth,
    request: { params: doctorParams },
    response: { status: 204 },
  }),
};

/** An organization's clinic branches and the doctors placed there (clinic visits, C4). Owners only. */
export default class OrgBranchController implements IBaseController {
  path = '/org/branches';
  router = Router();

  private branches = Container.get(BranchService);
  private organizations = Container.get(OrganizationService);
  private locations = Container.get(LocationService);
  private storage = Container.get(StorageService);

  constructor() {
    this.initializeRoutes();
  }

  initializeRoutes() {
    const org = (req: Request) => this.organizations.getOwn(req.user!.id);
    this.mount(r.list, async (req, res) => HttpResponse.ok(res, await this.presentAll(req)));
    this.mount(r.create, async (req, res) => {
      const created = await this.branches.create(await org(req), this.toInput(req.body));
      return HttpResponse.created(res, await this.presentOne(req, created._id));
    });
    this.mount(r.update, async (req, res) => {
      const body = req.body as z.infer<typeof ClinicSchemas.updateBody>;
      const updated = await this.branches.update(await org(req), req.params.id, {
        ...this.toInput(body),
        ...(body.is_active !== undefined ? { isActive: body.is_active } : {}),
      });
      return HttpResponse.ok(res, await this.presentOne(req, updated._id));
    });
    this.mount(r.remove, async (req, res) => {
      await this.branches.remove(await org(req), req.params.id);
      return HttpResponse.noContent(res);
    });
    this.mount(r.licence, async (req, res) => {
      const body = req.body as z.infer<typeof ClinicSchemas.licenceBody>;
      const updated = await this.branches.attachLicence(req.user!.id, await org(req), req.params.id, {
        fileKey: body.file_key,
        expiresAt: body.expires_at ? parseDateOnly(body.expires_at) : null,
      });
      return HttpResponse.ok(res, await this.presentOne(req, updated._id));
    });
    this.mount(r.submit, async (req, res) => {
      const updated = await this.branches.submit(await org(req), req.params.id);
      return HttpResponse.ok(res, await this.presentOne(req, updated._id));
    });
    this.mount(r.setDoctor, async (req, res) => {
      const body = req.body as {
        slot_minutes: number | null;
        hours: Array<{ day_of_week: number; start_time: string; end_time: string }>;
      };
      const { branch: updated } = await this.branches.setDoctorSchedule(
        await org(req),
        req.params.staffId,
        req.params.id,
        {
          slotMinutes: body.slot_minutes,
          hours: body.hours.map((h) => ({
            dayOfWeek: h.day_of_week,
            startTime: h.start_time,
            endTime: h.end_time,
          })),
        },
      );
      return HttpResponse.ok(res, await this.presentOne(req, updated._id));
    });
    this.mount(r.removeDoctor, async (req, res) => {
      await this.branches.removeDoctor(await org(req), req.params.staffId, req.params.id);
      return HttpResponse.noContent(res);
    });
  }

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

  private async presentAll(req: Request) {
    const rows = await this.branches.list(await this.organizations.getOwn(req.user!.id));
    const places = await this.locations.describeAreas(rows.map((r) => String(r.branch.areaId)));
    const lang = resolveLanguage(req);
    return Promise.all(rows.map((row) => this.present(row.branch, row.doctors, places, lang)));
  }

  private async presentOne(req: Request, branchId: Types.ObjectId) {
    return (await this.presentAll(req)).find((b) => b.id === String(branchId))!;
  }

  private async present(
    branchDoc: IClinic,
    doctors: Array<{ profileId: Types.ObjectId; name: string; link: IProviderClinic }>,
    places: Awaited<ReturnType<LocationService['describeAreas']>>,
    lang: ReturnType<typeof resolveLanguage>,
  ) {
    const { schedule: _schedule, ...base } = presentClinic(
      {
        clinic: branchDoc,
        link: null,
        licenceUrl: branchDoc.licence ? await this.storage.signedUrl(branchDoc.licence.fileKey) : null,
      },
      places,
      lang,
    );
    return {
      ...base,
      doctors: doctors.map((d) => ({
        staff_id: String(d.profileId),
        name: d.name,
        appointment_minutes: d.link.slotMinutes,
        hours: presentAvailability(d.link.hours),
      })),
    };
  }

  private mount(route: DefinedRoute, handler: (req: Request, res: Response) => Promise<unknown>) {
    this.router[route.method](
      route.path,
      CheckAppStatusMiddleware,
      route.validate,
      ...Auth(UserRole.OWNER),
      (req: Request, res: Response, next: NextFunction) => {
        handler(req, res).catch(next);
      },
    );
  }
}
