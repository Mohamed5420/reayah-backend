import { Router, type NextFunction, type Request, type Response } from 'express';
import { Container } from 'typedi';
import type IBaseController from '../interfaces/base-controller.interface';
import { CheckAppStatusMiddleware } from '../../middlewares/app';
import { Auth } from '../../middlewares/auth';
import { AddressSchemas } from '../../validations/address/address.validation';
import { z } from '../../validations/zod';
import { presentAddress } from '../../presenters/address.presenter';
import { defineRoute } from '../../../docs/openapi';
import { AddressService, type AddressInput } from '../../../services/address';
import { LocationService } from '../../../services/location';
import type { IAddress } from '../../../interfaces/IAddress';
import { UserRole } from '../../../interfaces/enums';
import { HttpResponse } from '../../../utils/response/http-response';
import { resolveLanguage, type Language } from '../../../utils/i18n';
import { camelizeKeys } from '../../../utils/case';

const tags = ['Patient — Addresses'];
const auth = true;

const routes = {
  list: defineRoute({
    method: 'get',
    path: '/addresses',
    summary: 'My addresses (default first)',
    tags,
    auth,
    response: { schema: z.array(AddressSchemas.address) },
  }),
  create: defineRoute({
    method: 'post',
    path: '/addresses',
    summary: 'Add an address (text only — coordinates are rejected). The first one becomes the default.',
    tags,
    auth,
    request: { body: AddressSchemas.createAddressBody },
    response: { status: 201, schema: AddressSchemas.address },
  }),
  update: defineRoute({
    method: 'patch',
    path: '/addresses/:id',
    summary: 'Update an address',
    tags,
    auth,
    request: { params: AddressSchemas.idParams, body: AddressSchemas.updateAddressBody },
    response: { schema: AddressSchemas.address },
  }),
  remove: defineRoute({
    method: 'delete',
    path: '/addresses/:id',
    summary: 'Delete an address (deleting the default promotes the newest remaining one)',
    tags,
    auth,
    request: { params: AddressSchemas.idParams },
    response: { status: 204 },
  }),
  setDefault: defineRoute({
    method: 'post',
    path: '/addresses/:id/default',
    summary: 'Make this the default address',
    tags,
    auth,
    request: { params: AddressSchemas.idParams },
    response: { schema: AddressSchemas.address },
  }),
};

/** Patient addresses (spec §7.5). */
export default class AddressController implements IBaseController {
  path = '/addresses';
  router = Router();

  private addresses = Container.get(AddressService);
  private locations = Container.get(LocationService);

  constructor() {
    this.initializeRoutes();
  }

  initializeRoutes() {
    for (const [route, handler] of [
      [routes.list, this.list],
      [routes.create, this.create],
      [routes.update, this.update],
      [routes.remove, this.remove],
      [routes.setDefault, this.setDefault],
    ] as const) {
      this.router[route.method](
        route.path,
        CheckAppStatusMiddleware,
        route.validate,
        ...Auth(UserRole.PATIENT),
        handler.bind(this),
      );
    }
  }

  private async list(req: Request, res: Response, next: NextFunction) {
    try {
      const addresses = await this.addresses.list(req.user!.id);
      return HttpResponse.ok(res, await this.present(addresses, resolveLanguage(req)));
    } catch (err) {
      next(err);
    }
  }

  private async create(req: Request, res: Response, next: NextFunction) {
    try {
      const { is_default, ...rest } = req.body as z.infer<typeof AddressSchemas.createAddressBody>;
      const address = await this.addresses.create(
        req.user!.id,
        camelizeKeys(rest) as AddressInput,
        is_default,
      );
      return HttpResponse.created(res, (await this.present([address], resolveLanguage(req)))[0]);
    } catch (err) {
      next(err);
    }
  }

  private async update(req: Request, res: Response, next: NextFunction) {
    try {
      const patch = camelizeKeys(req.body) as Partial<AddressInput>;
      const address = await this.addresses.update(req.user!.id, req.params.id, patch);
      return HttpResponse.ok(res, (await this.present([address], resolveLanguage(req)))[0]);
    } catch (err) {
      next(err);
    }
  }

  private async remove(req: Request, res: Response, next: NextFunction) {
    try {
      await this.addresses.remove(req.user!.id, req.params.id);
      return HttpResponse.noContent(res);
    } catch (err) {
      next(err);
    }
  }

  private async setDefault(req: Request, res: Response, next: NextFunction) {
    try {
      const address = await this.addresses.setDefault(req.user!.id, req.params.id);
      return HttpResponse.ok(res, (await this.present([address], resolveLanguage(req)))[0]);
    } catch (err) {
      next(err);
    }
  }

  private async present(addresses: IAddress[], lang: Language) {
    const places = await this.locations.describeAreas(addresses.map((a) => String(a.areaId)));
    return addresses.map((a) => presentAddress(a, places.get(String(a.areaId)), lang));
  }
}
