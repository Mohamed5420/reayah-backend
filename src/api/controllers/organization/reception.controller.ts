import { Router, type NextFunction, type Request, type Response } from 'express';
import { Container } from 'typedi';
import type IBaseController from '../interfaces/base-controller.interface';
import { CheckAppStatusMiddleware } from '../../middlewares/app';
import { Auth } from '../../middlewares/auth';
import { BookingSchemas } from '../../validations/booking/booking.validation';
import { ClinicSchemas } from '../../validations/clinic/clinic.validation';
import { objectId, z } from '../../validations/zod';
import { defineRoute, type DefinedRoute } from '../../../docs/openapi';
import { OrganizationService, ReceptionService } from '../../../services/organization';
import { auditContextFrom } from '../../../services/audit';
import { BookingStatus } from '../../../interfaces/IBooking';
import { UserRole } from '../../../interfaces/enums';
import { HttpResponse } from '../../../utils/response/http-response';
import { resolveLanguage } from '../../../utils/i18n';

const auth = true;
const ownerTags = ['Organization — Branches'];
const receptionTags = ['Reception'];
const branchParams = ClinicSchemas.idParams;
const memberParams = z.object({ id: objectId, userId: objectId });
const params = z.object({ id: objectId });

/** What reception sees of an appointment: never medical data, notes, prices or money. */
const appointment = z
  .object({
    id: z.string(),
    reference_code: z.string(),
    patient_name: z.string(),
    doctor_name: z.string().nullable(),
    service: z.string(),
    scheduled_start: z.string(),
    scheduled_end: z.string(),
    status: z.enum(BookingStatus),
    checked_in: z.enum(['code', 'without_code']).nullable(),
  })
  .openapi('ReceptionAppointment');

const r = {
  invite: defineRoute({
    method: 'post',
    path: '/org/branches/:id/reception',
    summary:
      'Invite a receptionist to this branch (SMS with the organization’s name and the app link only). The number must not have an account yet; they sign up with role reception.',
    tags: ownerTags,
    auth,
    request: {
      params: branchParams,
      body: z.strictObject({
        phone: z
          .string()
          .trim()
          .regex(/^\+201[0125]\d{8}$/, { error: 'validation.phone' }),
        full_name: z.string().trim().min(2).max(100),
      }),
    },
    response: { status: 201, schema: z.object({ invite_id: z.string(), expires_at: z.string() }) },
  }),
  list: defineRoute({
    method: 'get',
    path: '/org/branches/:id/reception',
    summary: 'Receptionists of this branch, and open invites',
    tags: ownerTags,
    auth,
    request: { params: branchParams },
    response: {
      schema: z.object({
        members: z.array(z.object({ user_id: z.string(), name: z.string(), phone: z.string() })),
        invites: z.array(
          z.object({ id: z.string(), name: z.string(), phone: z.string(), expires_at: z.string() }),
        ),
      }),
    },
  }),
  remove: defineRoute({
    method: 'delete',
    path: '/org/branches/:id/reception/:userId',
    summary:
      'Remove a receptionist from the branch: access ends and their sessions are signed out now. Audited.',
    tags: ownerTags,
    auth,
    request: { params: memberParams },
    response: { status: 204 },
  }),

  today: defineRoute({
    method: 'get',
    path: '/reception/appointments',
    summary:
      'Today’s appointments at my branch (Cairo day): patient name, time, doctor, status. Nothing medical, no notes, no prices. Audited.',
    tags: receptionTags,
    auth,
    response: { schema: appointment.array() },
  }),
  checkIn: defineRoute({
    method: 'post',
    path: '/reception/appointments/:id/check-in',
    summary:
      'Check the patient in with their 4-digit visit_code (shared 5 tries), or without_code_reason: starts the visit. Audited.',
    tags: receptionTags,
    auth,
    request: { params, body: BookingSchemas.startBody },
    response: { status: 204 },
  }),
  noShow: defineRoute({
    method: 'post',
    path: '/reception/appointments/:id/no-show',
    summary: 'The patient didn’t come (from start + clinic_no_show_grace_minutes). Audited.',
    tags: receptionTags,
    auth,
    request: { params },
    response: { status: 204 },
  }),
};

/** Branch reception (clinic visits, C4): the owner manages receptionists; receptionists run today's list. */
export default class ReceptionController implements IBaseController {
  path = '/reception';
  router = Router();

  private reception = Container.get(ReceptionService);
  private organizations = Container.get(OrganizationService);

  constructor() {
    this.initializeRoutes();
  }

  initializeRoutes() {
    const org = (req: Request) => this.organizations.getOwn(req.user!.id);
    const owner = [UserRole.OWNER];
    const reception = [UserRole.RECEPTION];

    this.mount(r.invite, owner, async (req, res) => {
      const invite = await this.reception.invite(await org(req), req.user!.id, req.params.id, {
        phone: req.body.phone,
        fullName: req.body.full_name,
      });
      return HttpResponse.created(res, {
        invite_id: String(invite._id),
        expires_at: invite.expiresAt.toISOString(),
      });
    });
    this.mount(r.list, owner, async (req, res) => {
      const { members, invites } = await this.reception.listForBranch(await org(req), req.params.id);
      return HttpResponse.ok(res, {
        members: members.map((m) => ({ user_id: String(m._id), name: m.fullName, phone: m.phone })),
        invites: invites.map((i) => ({
          id: String(i._id),
          name: i.fullName,
          phone: i.phone,
          expires_at: i.expiresAt.toISOString(),
        })),
      });
    });
    this.mount(r.remove, owner, async (req, res) => {
      await this.reception.remove(await org(req), req.params.id, req.params.userId, auditContextFrom(req));
      return HttpResponse.noContent(res);
    });

    this.mount(r.today, reception, async (req, res) => {
      const lang = resolveLanguage(req);
      const rows = await this.reception.today(req.user!.id, auditContextFrom(req));
      return HttpResponse.ok(
        res,
        rows.map(({ booking: b, patientName, doctorName }) => ({
          id: String(b._id),
          reference_code: b.referenceCode,
          patient_name: patientName,
          doctor_name: doctorName,
          service: lang === 'en' && b.service.nameEn ? b.service.nameEn : b.service.nameAr,
          scheduled_start: b.scheduledStart.toISOString(),
          scheduled_end: b.scheduledEnd.toISOString(),
          status: b.status,
          checked_in: b.checkIn?.method ?? null,
        })),
      );
    });
    this.mount(r.checkIn, reception, async (req, res) => {
      const body = (req.body ?? {}) as z.infer<typeof BookingSchemas.startBody>;
      await this.reception.checkIn(
        req.user!.id,
        req.params.id,
        { visitCode: body.visit_code, withoutCodeReason: body.without_code_reason },
        auditContextFrom(req),
      );
      return HttpResponse.noContent(res);
    });
    this.mount(r.noShow, reception, async (req, res) => {
      await this.reception.noShow(req.user!.id, req.params.id, auditContextFrom(req));
      return HttpResponse.noContent(res);
    });
  }

  private mount(
    route: DefinedRoute,
    roles: UserRole[],
    handler: (req: Request, res: Response) => Promise<unknown>,
  ) {
    this.router[route.method](
      route.path,
      CheckAppStatusMiddleware,
      route.validate,
      ...Auth(...roles),
      (req: Request, res: Response, next: NextFunction) => {
        handler(req, res).catch(next);
      },
    );
  }
}
