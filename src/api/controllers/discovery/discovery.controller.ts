import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { Container } from 'typedi';
import type IBaseController from '../interfaces/base-controller.interface';
import { CheckAppStatusMiddleware } from '../../middlewares/app';
import { Auth } from '../../middlewares/auth';
import { DiscoverySchemas } from '../../validations/discovery/discovery.validation';
import { paginationQuery, type z } from '../../validations/zod';
import {
  presentProviderCard,
  presentPublicProfile,
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
    summary: 'Provider public profile',
    tags,
    auth,
    request: { params: DiscoverySchemas.idParams },
    response: { schema: DiscoverySchemas.providerProfile },
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
      const [{ user }, categories, upcoming] = await Promise.all([
        this.users.getMe(req.user!.id),
        this.catalog.activeCategories(),
        this.bookings.nextUpcoming(req.user!.id),
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
        active_package: null, // packages: Phase 2
        banners: [], // banners: Phase 2
      });
    } catch (err) {
      next(err);
    }
  }

  private async search(req: Request, res: Response, next: NextFunction) {
    try {
      const q = req.query as unknown as z.infer<typeof DiscoverySchemas.searchQuery>;
      const pagination = parsePagination(req.query);
      const { data, total, service } = await this.discovery.search(
        {
          serviceId: q.service_id,
          areaId: q.area_id,
          date: q.date,
          time: q.time,
          gender: q.gender,
          providerType: q.provider_type,
          minPrice: q.min_price,
          maxPrice: q.max_price,
          minRating: q.min_rating,
          source: q.source,
          sort: q.sort,
        },
        pagination,
      );
      const cards = await Promise.all(
        data.map(async (card) =>
          presentProviderCard(card, service, await this.avatarUrl(card.user.avatarKey)),
        ),
      );
      return HttpResponse.paginated(res, cards, pagination, total);
    } catch (err) {
      next(err);
    }
  }

  private async profile(req: Request, res: Response, next: NextFunction) {
    try {
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
      const { profile } = await this.discovery.getPublicProfile(req.params.id); // 404 for unknown providers
      const pagination = parsePagination(req.query);
      const { data, total } = await this.reviewService.listForProvider(profile._id, pagination);
      return HttpResponse.paginated(res, data.map(presentPublicReview), pagination, total);
    } catch (err) {
      next(err);
    }
  }

  private async slots(req: Request, res: Response, next: NextFunction) {
    try {
      const q = req.query as unknown as z.infer<typeof DiscoverySchemas.slotsQuery>;
      const slots = await this.discovery.providerSlots(req.params.id, q.service_id, q.date, q.quantity);
      return HttpResponse.ok(res, presentSlots(q.date, slots));
    } catch (err) {
      next(err);
    }
  }

  private avatarUrl(key: string | null) {
    return key ? this.storage.signedUrl(key) : Promise.resolve(null);
  }
}
