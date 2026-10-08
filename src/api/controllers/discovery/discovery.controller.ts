import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { Container } from 'typedi';
import type IBaseController from '../interfaces/base-controller.interface';
import { CheckAppStatusMiddleware } from '../../middlewares/app';
import { Auth } from '../../middlewares/auth';
import { DiscoverySchemas } from '../../validations/discovery/discovery.validation';
import { paginationQuery, z } from '../../validations/zod';
import {
  presentOrgPublicProfile,
  presentPublicProfile,
  presentSearchCard,
  presentSlots,
} from '../../presenters/discovery.presenter';
import { presentCategory } from '../../presenters/catalog.presenter';
import { defineRoute, type DefinedRoute } from '../../../docs/openapi';
import { DiscoveryService } from '../../../services/discovery';
import { CatalogService } from '../../../services/catalog';
import { StorageService } from '../../../services/storage';
import { UserService } from '../../../services/user';
import { BookingService } from '../../../services/booking';
import { ReviewService } from '../../../services/aftercare';
import { presentPublicReview } from '../../presenters/aftercare.presenter';
import { localized } from '../../presenters/localize';
import { UserRole } from '../../../interfaces/enums';
import { HttpResponse } from '../../../utils/response/http-response';
import { parsePagination } from '../../../utils/response/pagination';
import { resolveLanguage } from '../../../utils/i18n';
import { BannerService, PackageService } from '../../../services/marketing';
import { presentHomeBanner } from '../../presenters/marketing.presenter';
import { OrgDiscoveryService } from '../../../services/organization/org-discovery.service';
import { ProviderProfileModel } from '../../../database/models/provider/provider-profile.model';
import type { Types } from 'mongoose';
import { perVisitValue } from '../../../interfaces/IMarketing';
import { ValidationError } from '../../../utils/types-errors';

const tags = ['Patient — Discovery'];
const auth = true;

const r = {
  home: defineRoute({
    method: 'get',
    path: '/home',
    summary: 'Patient home screen',
    tags,
    auth,
    response: { schema: DiscoverySchemas.home },
  }),
  search: defineRoute({
    method: 'get',
    path: '/providers',
    summary:
      'Search providers by service and area (never distance). Approved, accepting, active accounts only. ' +
      '`date` (+ optional `time`) keeps only providers with a free slot then.',
    tags,
    auth,
    request: { query: DiscoverySchemas.searchQuery },
    response: { schema: DiscoverySchemas.providerCard, paginated: true },
  }),
  profile: defineRoute({
    method: 'get',
    path: '/providers/:id',
    summary:
      "Provider public profile — or an organization's, for an organization id from search (kind tells them apart)",
    tags,
    auth,
    request: { params: DiscoverySchemas.idParams },
    response: { schema: z.union([DiscoverySchemas.providerProfile, DiscoverySchemas.organizationProfile]) },
  }),
  reviews: defineRoute({
    method: 'get',
    path: '/providers/:id/reviews',
    summary: 'Provider reviews, newest first (reviewer shown by first name + initial)',
    tags,
    auth,
    request: { params: DiscoverySchemas.idParams, query: paginationQuery },
    response: { schema: DiscoverySchemas.review, paginated: true },
  }),
  slots: defineRoute({
    method: 'get',
    path: '/providers/:id/slots',
    summary: 'Bookable slots on a Cairo date (every 30 min, ≥ 60 min ahead, ≤ 60 days out)',
    tags,
    auth,
    request: { params: DiscoverySchemas.idParams, query: DiscoverySchemas.slotsQuery },
    response: { schema: DiscoverySchemas.slots },
  }),
};

/** Patient discovery (spec §7.7). Any signed-in role can browse; /home is the patient home screen. */
export default class DiscoveryController implements IBaseController {
  path = '/';
  router = Router();

  private discovery = Container.get(DiscoveryService);
  private catalog = Container.get(CatalogService);
  private storage = Container.get(StorageService);
  private reviewService = Container.get(ReviewService);
  private users = Container.get(UserService);
  private bookings = Container.get(BookingService);
  private orgDiscovery = Container.get(OrgDiscoveryService);
  private packages = Container.get(PackageService);
  private banners = Container.get(BannerService);

  constructor() {
    this.initializeRoutes();
  }

  initializeRoutes() {
    this.mount(r.home, this.home, [UserRole.PATIENT]);
    this.mount(r.search, this.search);
    this.mount(r.profile, this.profile);
    this.mount(r.reviews, this.reviews);
    this.mount(r.slots, this.slots);
  }

  private mount(route: DefinedRoute, handler: RequestHandler, roles: UserRole[] = []) {
    this.router[route.method](
      route.path,
      CheckAppStatusMiddleware,
      route.validate,
      ...Auth(...roles),
      handler.bind(this),
    );
  }

  private async home(req: Request, res: Response, next: NextFunction) {
    try {
      const lang = resolveLanguage(req);
      const [{ user }, categories, upcoming, activePackage, banners] = await Promise.all([
        this.users.getMe(req.user!.id),
        this.catalog.activeCategories(),
        this.bookings.nextUpcoming(req.user!.id),
        this.packages.activeForHome(req.user!.id),
        this.banners.active(),
      ]);
      const provider = upcoming?.providerProfileId
        ? (await this.bookings.providerCards([upcoming])).get(String(upcoming.providerProfileId))
        : undefined;
      return HttpResponse.ok(res, {
        greeting_name: user.fullName.split(' ')[0],
        categories: categories.map((c) => presentCategory(c, lang)),
        upcoming_booking: upcoming
          ? {
              id: String(upcoming._id),
              status: upcoming.status,
              service_name: localized(upcoming.service.nameAr, upcoming.service.nameEn, lang),
              scheduled_start: upcoming.scheduledStart.toISOString(),
              provider_name: provider?.name ?? null,
            }
          : null,
        active_package: activePackage
          ? {
              id: String(activePackage._id),
              name: localized(activePackage.package.nameAr, activePackage.package.nameEn, lang),
              visits_remaining: activePackage.visitsRemaining,
              expires_at: activePackage.expiresAt ? activePackage.expiresAt.toISOString() : null,
            }
          : null,
        banners: await Promise.all(
          banners.map(async (b) => presentHomeBanner(b, await this.banners.imageUrl(b.imageKey), lang)),
        ),
      });
    } catch (err) {
      next(err);
    }
  }

  private async search(req: Request, res: Response, next: NextFunction) {
    try {
      const q = req.query as unknown as z.infer<typeof DiscoverySchemas.searchQuery>;
      const pagination = parsePagination(req.query);
      if (q.package_id) {
        // Booking with a package: only providers at or below its per-visit value (product decision).
        const { pkg } = await this.packages.getAvailable(q.package_id);
        if (String(pkg.serviceId) !== q.service_id) {
          throw new ValidationError({ package_id: ['validation.package_other_service'] });
        }
        q.max_price = Math.min(q.max_price ?? Infinity, perVisitValue(pkg));
      }
      const { data, total, service } = await this.discovery.searchWithOrganizations(
        {
          serviceId: q.service_id,
          areaId: q.area_id,
          date: q.date,
          time: q.time,
          gender: q.gender,
          providerType: q.provider_type,
          specialty: q.specialty,
          minPrice: q.min_price,
          maxPrice: q.max_price,
          minRating: q.min_rating,
          source: q.source,
          sort: q.sort,
          testAccount: req.user?.isTestAccount,
        },
        pagination,
      );
      const cards = await Promise.all(
        data.map(async (card) =>
          presentSearchCard(
            card,
            service,
            await this.avatarUrl(card.kind === 'provider' ? card.user.avatarKey : card.org.logoKey),
            resolveLanguage(req),
          ),
        ),
      );
      return HttpResponse.paginated(res, cards, pagination, total);
    } catch (err) {
      next(err);
    }
  }

  private async profile(req: Request, res: Response, next: NextFunction) {
    try {
      if (await this.orgDiscovery.isOrganization(req.params.id)) {
        const org = await this.orgDiscovery.publicProfile(req.params.id);
        const staffIds = await this.orgStaffIds(org.org._id);
        return HttpResponse.ok(
          res,
          presentOrgPublicProfile({
            ...org,
            logoUrl: await this.avatarUrl(org.org.logoKey),
            recentReviews: (await this.reviewService.recentForProvider(staffIds)).map(presentPublicReview),
            lang: resolveLanguage(req),
          }),
        );
      }
      const result = await this.discovery.getPublicProfile(req.params.id);
      return HttpResponse.ok(
        res,
        presentPublicProfile({
          ...result,
          recentReviews: (await this.reviewService.recentForProvider(result.profile._id)).map(
            presentPublicReview,
          ),
          avatarUrl: await this.avatarUrl(result.user.avatarKey),
          lang: resolveLanguage(req),
        }),
      );
    } catch (err) {
      next(err);
    }
  }

  private async reviews(req: Request, res: Response, next: NextFunction) {
    try {
      // An organization's reviews are its staff's; 404 for unknown ids.
      const ids = (await this.orgDiscovery.isOrganization(req.params.id))
        ? await this.orgStaffIds((await this.orgDiscovery.approvedOrg(req.params.id))._id)
        : (await this.discovery.getPublicProfile(req.params.id)).profile._id;
      const pagination = parsePagination(req.query);
      const { data, total } = await this.reviewService.listForProvider(ids, pagination);
      return HttpResponse.paginated(res, data.map(presentPublicReview), pagination, total);
    } catch (err) {
      next(err);
    }
  }

  private async slots(req: Request, res: Response, next: NextFunction) {
    try {
      const q = req.query as unknown as z.infer<typeof DiscoverySchemas.slotsQuery>;
      const slots = (await this.orgDiscovery.isOrganization(req.params.id))
        ? await this.orgDiscovery.slots(req.params.id, {
            serviceId: q.service_id,
            date: q.date,
            quantity: q.quantity,
            areaId: q.area_id,
            gender: q.gender,
          })
        : await this.discovery.providerSlots(req.params.id, q.service_id, q.date, q.quantity);
      return HttpResponse.ok(res, presentSlots(q.date, slots));
    } catch (err) {
      next(err);
    }
  }

  private avatarUrl(key: string | null) {
    return key ? this.storage.signedUrl(key) : Promise.resolve(null);
  }

  /** An organization's staff (current members) — its page shows their reviews. */
  private async orgStaffIds(orgId: Types.ObjectId) {
    return (await ProviderProfileModel.find({ organizationId: orgId }).select('_id').lean()).map(
      (p) => p._id,
    );
  }
}
