import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { Container } from 'typedi';
import type IBaseController from '../interfaces/base-controller.interface';
import { CheckAppStatusMiddleware } from '../../middlewares/app';
import { Auth } from '../../middlewares/auth';
import { OrgBookingSchemas } from '../../validations/organization/organization.validation';
import { type z } from '../../validations/zod';
import { presentEligibleStaff, presentOrgBooking } from '../../presenters/organization.presenter';
import { defineRoute, type DefinedRoute } from '../../../docs/openapi';
import { OrgBookingService, OrganizationService } from '../../../services/organization';
import { UserRole } from '../../../interfaces/enums';
import { HttpResponse } from '../../../utils/response/http-response';
import { parsePagination } from '../../../utils/response/pagination';
import { resolveLanguage } from '../../../utils/i18n';

const tags = ['Owner — Bookings'];
const auth = true;
const params = OrgBookingSchemas.idParams;

const r = {
  list: defineRoute({
    method: 'get',
    path: '/org/bookings',
    summary: 'All bookings of the organization (pending ones are its queue), by visit time',
    tags,
    auth,
    request: { query: OrgBookingSchemas.listQuery },
    response: { schema: OrgBookingSchemas.booking, paginated: true },
  }),
  offers: defineRoute({
    method: 'get',
    path: '/org/offers',
    summary:
      "Other organizations' / providers' requests offered to this organization after their deadline. Take one by assigning a free staff member (first to take it wins).",
    tags,
    auth,
    response: { schema: OrgBookingSchemas.booking.array() },
  }),
  detail: defineRoute({
    method: 'get',
    path: '/org/bookings/:id',
    summary:
      'Booking details. The patient’s name, phone and address appear once a staff member is assigned; never notes or medical data.',
    tags,
    auth,
    request: { params },
    response: { schema: OrgBookingSchemas.booking },
  }),
  eligible: defineRoute({
    method: 'get',
    path: '/org/bookings/:id/eligible-staff',
    summary:
      'Staff sorted by availability then rating; unavailable ones flagged `available: false` with the reason (area, service, preferred gender, busy…)',
    tags,
    auth,
    request: { params },
    response: { schema: OrgBookingSchemas.eligibleStaff.array() },
  }),
  assign: defineRoute({
    method: 'post',
    path: '/org/bookings/:id/assign',
    summary:
      'Assign a staff member — the organization accepts at once. 409 SLOT_UNAVAILABLE if they’re busy or don’t cover it; 409 ASSIGNMENT_DEADLINE_PASSED after the deadline.',
    tags,
    auth,
    request: { params, body: OrgBookingSchemas.assignBody },
    response: { schema: OrgBookingSchemas.booking },
  }),
  reassign: defineRoute({
    method: 'post',
    path: '/org/bookings/:id/reassign',
    summary:
      'Change the assigned staff member of an accepted booking (the previous one loses access and the chat)',
    tags,
    auth,
    request: { params, body: OrgBookingSchemas.assignBody },
    response: { schema: OrgBookingSchemas.booking },
  }),
  broadcast: defineRoute({
    method: 'post',
    path: '/org/bookings/:id/broadcast',
    summary:
      '"Send to all suitable": offers it to every eligible free staff member until the deadline; first to accept wins',
    tags,
    auth,
    request: { params },
    response: { schema: OrgBookingSchemas.broadcastResult },
  }),
  decline: defineRoute({
    method: 'post',
    path: '/org/bookings/:id/decline',
    summary:
      'Decline on behalf of the organization: its own request goes straight to other providers (if the patient allowed it), else it is declined; an offered request is passed on',
    tags,
    auth,
    request: { params, body: OrgBookingSchemas.declineBody },
    response: { schema: OrgBookingSchemas.declineResult },
  }),
  cancel: defineRoute({
    method: 'post',
    path: '/org/bookings/:id/cancel',
    summary: 'Cancel an assigned booking before the visit starts (a pending one is declined instead)',
    tags,
    auth,
    request: { params, body: OrgBookingSchemas.cancelBody },
    response: { schema: OrgBookingSchemas.booking },
  }),
};

/** Owner — the organization's bookings, assignment and broadcast (spec §6.6, §7.11 "Bookings", M3.3). */
export default class OrgBookingController implements IBaseController {
  path = '/org/bookings';
  router = Router();

  private organizations = Container.get(OrganizationService);
  private bookings = Container.get(OrgBookingService);

  constructor() {
    this.initializeRoutes();
  }

  initializeRoutes() {
    const org = (req: Request) => this.organizations.getOwn(req.user!.id);

    this.mount(r.list, async (req, res) => {
      const q = req.query as unknown as z.infer<typeof OrgBookingSchemas.listQuery>;
      const pagination = parsePagination(req.query);
      const { data, total, staff } = await this.bookings.list(
        await org(req),
        { status: q.status, date: q.date, staffId: q.staff_id },
        pagination,
      );
      const lang = resolveLanguage(req);
      return HttpResponse.paginated(
        res,
        data.map((booking) =>
          presentOrgBooking({
            booking,
            offer: null,
            staff: booking.providerProfileId ? (staff.get(String(booking.providerProfileId)) ?? null) : null,
            patient: null,
            lang,
          }),
        ),
        pagination,
        total,
      );
    });
    this.mount(r.offers, async (req, res) => {
      const lang = resolveLanguage(req);
      const rows = await this.bookings.offers(await org(req));
      return HttpResponse.ok(
        res,
        rows.map(({ offer, booking }) =>
          presentOrgBooking({ booking, offer, staff: null, patient: null, lang }),
        ),
      );
    });
    this.mount(r.detail, async (req, res) => HttpResponse.ok(res, await this.view(req)));
    this.mount(r.eligible, async (req, res) =>
      HttpResponse.ok(
        res,
        (await this.bookings.eligibleStaff(await org(req), req.params.id)).map(presentEligibleStaff),
      ),
    );
    this.mount(r.assign, async (req, res) => {
      const body = req.body as z.infer<typeof OrgBookingSchemas.assignBody>;
      await this.bookings.assign(await org(req), req.user!.id, req.params.id, body.provider_profile_id);
      return HttpResponse.ok(res, await this.view(req));
    });
    this.mount(r.reassign, async (req, res) => {
      const body = req.body as z.infer<typeof OrgBookingSchemas.assignBody>;
      await this.bookings.reassign(await org(req), req.user!.id, req.params.id, body.provider_profile_id);
      return HttpResponse.ok(res, await this.view(req));
    });
    this.mount(r.broadcast, async (req, res) =>
      HttpResponse.ok(res, await this.bookings.broadcast(await org(req), req.params.id)),
    );
    this.mount(r.decline, async (req, res) => {
      const body = req.body as z.infer<typeof OrgBookingSchemas.declineBody>;
      const result = await this.bookings.decline(
        await org(req),
        req.user!.id,
        req.params.id,
        body.reason_code,
      );
      return HttpResponse.ok(res, { status: result.status, passed_on: result.passedOn });
    });
    this.mount(r.cancel, async (req, res) => {
      const body = req.body as z.infer<typeof OrgBookingSchemas.cancelBody>;
      await this.bookings.cancel(await org(req), req.user!.id, req.params.id, {
        code: body.reason_code,
        text: body.reason_text,
      });
      return HttpResponse.ok(res, await this.view(req));
    });
  }

  private async view(req: Request) {
    const detail = await this.bookings.detail(await this.organizations.getOwn(req.user!.id), req.params.id);
    return presentOrgBooking({ ...detail, lang: resolveLanguage(req) });
  }

  private mount(route: DefinedRoute, handler: (req: Request, res: Response) => Promise<unknown>) {
    this.router[route.method](
      route.path,
      CheckAppStatusMiddleware,
      route.validate,
      ...Auth(UserRole.OWNER),
      this.handle(handler),
    );
  }

  private handle(handler: (req: Request, res: Response) => Promise<unknown>): RequestHandler {
    // Express 4 doesn't forward rejected promises itself.
    return (req: Request, res: Response, next: NextFunction) => {
      handler(req, res).catch(next);
    };
  }
}
