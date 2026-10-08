import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { Container } from 'typedi';
import type IBaseController from '../interfaces/base-controller.interface';
import { CheckAppStatusMiddleware } from '../../middlewares/app';
import { AdminGuard } from '../../middlewares/auth';
import { MarketingSchemas } from '../../validations/marketing/marketing.validation';
import { z } from '../../validations/zod';
import {
  presentAdminBanner,
  presentAdminPackage,
  presentAdminPromo,
} from '../../presenters/marketing.presenter';
import { defineRoute, type DefinedRoute } from '../../../docs/openapi';
import {
  BannerService,
  PackageAdminService,
  PromoAdminService,
  type BannerInput,
  type PackageInput,
  type PromoInput,
} from '../../../services/marketing';
import { auditContextFrom } from '../../../services/audit';
import type { IBanner } from '../../../interfaces/IMarketing';
import { HttpResponse } from '../../../utils/response/http-response';
import { parsePagination } from '../../../utils/response/pagination';
import { camelizeKeys } from '../../../utils/case';

const tags = ['Admin — Marketing'];
const auth = true;
const params = MarketingSchemas.idParams;

const r = {
  listPromos: defineRoute({
    method: 'get',
    path: '/admin/promo-codes',
    summary: 'Promo codes, newest first, with uses so far',
    tags,
    auth,
    request: { query: MarketingSchemas.adminPromoQuery },
    response: { schema: MarketingSchemas.adminPromo, paginated: true },
  }),
  createPromo: defineRoute({
    method: 'post',
    path: '/admin/promo-codes',
    summary:
      'Create a promo code (percent or fixed; limits; validity). The discount comes out of the platform commission — provider payouts are unchanged.',
    tags,
    auth,
    request: { body: MarketingSchemas.createPromoBody },
    response: { status: 201, schema: MarketingSchemas.adminPromo },
  }),
  updatePromo: defineRoute({
    method: 'patch',
    path: '/admin/promo-codes/:id',
    summary: 'Update a promo code',
    tags,
    auth,
    request: { params, body: MarketingSchemas.updatePromoBody },
    response: { schema: MarketingSchemas.adminPromo },
  }),
  deactivatePromo: defineRoute({
    method: 'delete',
    path: '/admin/promo-codes/:id',
    summary: 'Deactivate a promo code',
    tags,
    auth,
    request: { params },
    response: { status: 204 },
  }),
  listPackages: defineRoute({
    method: 'get',
    path: '/admin/packages',
    summary: 'Platform packages, with how many were sold',
    tags,
    auth,
    request: { query: MarketingSchemas.adminPackagesQuery },
    response: { schema: MarketingSchemas.adminPackage, paginated: true },
  }),
  createPackage: defineRoute({
    method: 'post',
    path: '/admin/packages',
    summary:
      'Create a platform package. per_visit_value = price ÷ visits; only providers at or below it can be booked with it.',
    tags,
    auth,
    request: { body: MarketingSchemas.createPackageBody },
    response: { status: 201, schema: MarketingSchemas.adminPackage },
  }),
  updatePackage: defineRoute({
    method: 'patch',
    path: '/admin/packages/:id',
    summary: 'Update / deactivate a package (packages already sold keep their terms)',
    tags,
    auth,
    request: { params, body: MarketingSchemas.updatePackageBody },
    response: { schema: MarketingSchemas.adminPackage },
  }),
  listBanners: defineRoute({
    method: 'get',
    path: '/admin/banners',
    summary: 'Home banners (incl. inactive and scheduled)',
    tags,
    auth,
    response: { schema: z.array(MarketingSchemas.adminBanner) },
  }),
  createBanner: defineRoute({
    method: 'post',
    path: '/admin/banners',
    summary: 'Create a home banner from an uploaded image (POST /uploads, purpose `banner`)',
    tags,
    auth,
    request: { body: MarketingSchemas.createBannerBody },
    response: { status: 201, schema: MarketingSchemas.adminBanner },
  }),
  updateBanner: defineRoute({
    method: 'patch',
    path: '/admin/banners/:id',
    summary: 'Update a home banner',
    tags,
    auth,
    request: { params, body: MarketingSchemas.updateBannerBody },
    response: { schema: MarketingSchemas.adminBanner },
  }),
  deleteBanner: defineRoute({
    method: 'delete',
    path: '/admin/banners/:id',
    summary: 'Delete a home banner',
    tags,
    auth,
    request: { params },
    response: { status: 204 },
  }),
};

/** Dates arrive as ISO strings; the services take Dates (null clears). */
const withDates = <T extends Record<string, unknown>>(input: T, fields: string[]) => {
  const out: Record<string, unknown> = { ...input };
  for (const f of fields) if (typeof out[f] === 'string') out[f] = new Date(out[f] as string);
  return out;
};

/** Admin panel: promo codes, packages and home banners (spec §7.15 "Marketing"). Every write is audited. */
export default class AdminMarketingController implements IBaseController {
  path = '/admin';
  router = Router();

  private promos = Container.get(PromoAdminService);
  private packages = Container.get(PackageAdminService);
  private banners = Container.get(BannerService);

  constructor() {
    this.initializeRoutes();
  }

  initializeRoutes() {
    this.mount(r.listPromos, async (req, res) => {
      const q = req.query as unknown as z.infer<typeof MarketingSchemas.adminPromoQuery>;
      const pagination = parsePagination(req.query);
      const { data, total } = await this.promos.list({ isActive: q.is_active, search: q.search }, pagination);
      return HttpResponse.paginated(res, data.map(presentAdminPromo), pagination, total);
    });
    this.mount(r.createPromo, async (req, res) => {
      const input = withDates(camelizeKeys(req.body), ['validFrom', 'validTo']) as PromoInput;
      return HttpResponse.created(
        res,
        presentAdminPromo(await this.promos.create(input, auditContextFrom(req))),
      );
    });
    this.mount(r.updatePromo, async (req, res) => {
      const patch = withDates(camelizeKeys(req.body), ['validFrom', 'validTo']) as Partial<PromoInput>;
      const promo = await this.promos.update(req.params.id, patch, auditContextFrom(req));
      return HttpResponse.ok(res, presentAdminPromo(promo));
    });
    this.mount(r.deactivatePromo, async (req, res) => {
      await this.promos.deactivate(req.params.id, auditContextFrom(req));
      return HttpResponse.noContent(res);
    });

    this.mount(r.listPackages, async (req, res) => {
      const q = req.query as unknown as z.infer<typeof MarketingSchemas.adminPackagesQuery>;
      const pagination = parsePagination(req.query);
      const { data, total } = await this.packages.list({ isActive: q.is_active }, pagination);
      return HttpResponse.paginated(res, data.map(presentAdminPackage), pagination, total);
    });
    this.mount(r.createPackage, async (req, res) => {
      const input = camelizeKeys(req.body) as PackageInput;
      const pkg = await this.packages.create(input, auditContextFrom(req));
      return HttpResponse.created(res, presentAdminPackage(pkg));
    });
    this.mount(r.updatePackage, async (req, res) => {
      const patch = camelizeKeys(req.body) as Partial<PackageInput>;
      const pkg = await this.packages.update(req.params.id, patch, auditContextFrom(req));
      return HttpResponse.ok(res, presentAdminPackage(pkg));
    });

    this.mount(r.listBanners, async (_req, res) => {
      const banners = await this.banners.list();
      return HttpResponse.ok(res, await Promise.all(banners.map((b) => this.presentBanner(b))));
    });
    this.mount(r.createBanner, async (req, res) => {
      const input = withDates(camelizeKeys(req.body), ['startsAt', 'endsAt']) as BannerInput;
      const banner = await this.banners.create(input, auditContextFrom(req));
      return HttpResponse.created(res, await this.presentBanner(banner));
    });
    this.mount(r.updateBanner, async (req, res) => {
      const patch = withDates(camelizeKeys(req.body), ['startsAt', 'endsAt']) as BannerInput;
      const banner = await this.banners.update(req.params.id, patch, auditContextFrom(req));
      return HttpResponse.ok(res, await this.presentBanner(banner));
    });
    this.mount(r.deleteBanner, async (req, res) => {
      await this.banners.remove(req.params.id, auditContextFrom(req));
      return HttpResponse.noContent(res);
    });
  }

  private async presentBanner(banner: IBanner) {
    return presentAdminBanner(banner, await this.banners.imageUrl(banner.imageKey));
  }

  private mount(route: DefinedRoute, handler: (req: Request, res: Response) => Promise<unknown>) {
    this.router[route.method](
      route.path,
      CheckAppStatusMiddleware,
      route.validate,
      ...AdminGuard,
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
