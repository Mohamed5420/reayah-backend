import { Router, type NextFunction, type Request, type Response } from 'express';
import { Container } from 'typedi';
import type IBaseController from '../interfaces/base-controller.interface';
import { CheckAppStatusMiddleware, UploadMiddleware } from '../../middlewares/app';
import { IMAGE_MIMES } from '../../../utils/file-type';
import { Auth } from '../../middlewares/auth';
import { AuthSchemas, parseDateOnly } from '../../validations/auth/auth.validation';
import type { z } from '../../validations/zod';
import { presentMe } from '../../presenters/user.presenter';
import { defineRoute } from '../../../docs/openapi';
import { DeleteAccountUseCase, DeviceService, UpdateMeUseCase, UserService } from '../../../services/user';
import { auditContextFrom } from '../../../services/audit';
import { HttpResponse } from '../../../utils/response/http-response';
import { camelizeKeys } from '../../../utils/case';
import { UserStatus } from '../../../interfaces/enums';

const tags = ['Me'];
const auth = true;

const routes = {
  getMe: defineRoute({
    method: 'get',
    path: '/me',
    summary: 'Current user + role-specific summary',
    tags,
    auth,
    response: { schema: AuthSchemas.me },
  }),
  updateMe: defineRoute({
    method: 'patch',
    path: '/me',
    summary: 'Update name, email, gender, date of birth, language',
    tags,
    auth,
    request: { body: AuthSchemas.updateMeBody },
    response: { schema: AuthSchemas.me },
  }),
  deleteMe: defineRoute({
    method: 'delete',
    path: '/me',
    summary: 'Close the account (sessions end now; data retained per the retention policy)',
    tags,
    auth,
    request: { body: AuthSchemas.deleteMeBody },
    response: { status: 202, schema: AuthSchemas.accountDeleted },
  }),
  registerDevice: defineRoute({
    method: 'post',
    path: '/me/devices',
    summary: 'Register or refresh this device’s FCM token',
    tags,
    auth,
    request: { body: AuthSchemas.deviceBody },
    response: { status: 204 },
  }),
  removeDevice: defineRoute({
    method: 'delete',
    path: '/me/devices/:fcm_token',
    summary: 'Remove a device’s FCM token',
    tags,
    auth,
    request: { params: AuthSchemas.deviceParams },
    response: { status: 204 },
  }),
  uploadAvatar: defineRoute({
    method: 'post',
    path: '/me/avatar',
    summary: 'Upload a profile photo (JPG or PNG, max 10 MB); replaces the previous one',
    tags,
    auth,
    upload: { field: 'file' },
    response: { schema: AuthSchemas.me },
  }),
};

/** The signed-in account, any role (spec §7.2). Referral: Phase 2. */
export default class MeController implements IBaseController {
  path = '/me';
  router = Router();

  private users = Container.get(UserService);
  private updateMeUseCase = Container.get(UpdateMeUseCase);
  private deleteAccount = Container.get(DeleteAccountUseCase);
  private devices = Container.get(DeviceService);

  constructor() {
    this.initializeRoutes();
  }

  initializeRoutes() {
    for (const [route, handler] of [
      [routes.getMe, this.getMe],
      [routes.updateMe, this.updateMe],
      [routes.deleteMe, this.deleteMe],
      [routes.registerDevice, this.registerDevice],
      [routes.removeDevice, this.removeDevice],
    ] as const) {
      this.router[route.method](
        route.path,
        CheckAppStatusMiddleware,
        route.validate,
        ...Auth(),
        handler.bind(this),
      );
    }

    this.router.post(
      routes.uploadAvatar.path,
      CheckAppStatusMiddleware,
      ...Auth(),
      UploadMiddleware('file', IMAGE_MIMES),
      this.uploadAvatar.bind(this),
    );
  }

  private async uploadAvatar(req: Request, res: Response, next: NextFunction) {
    try {
      return HttpResponse.ok(res, presentMe(await this.users.setAvatar(req.user!.id, req.file!)));
    } catch (err) {
      next(err);
    }
  }

  private async getMe(req: Request, res: Response, next: NextFunction) {
    try {
      const me = await this.users.getMe(req.user!.id);
      return HttpResponse.ok(res, presentMe(me));
    } catch (err) {
      next(err);
    }
  }

  private async updateMe(req: Request, res: Response, next: NextFunction) {
    try {
      const body = req.body as z.infer<typeof AuthSchemas.updateMeBody>;
      const { date_of_birth, ...rest } = body;
      const me = await this.updateMeUseCase.execute(req.user!.id, {
        ...camelizeKeys(rest),
        ...(date_of_birth ? { dateOfBirth: parseDateOnly(date_of_birth) } : {}),
      });
      return HttpResponse.ok(res, presentMe(me));
    } catch (err) {
      next(err);
    }
  }

  private async deleteMe(req: Request, res: Response, next: NextFunction) {
    try {
      const { deletionRequestedAt } = await this.deleteAccount.execute(
        req.user!.id,
        req.body?.reason,
        auditContextFrom(req),
      );
      return HttpResponse.accepted(res, {
        status: UserStatus.DELETED,
        deletion_requested_at: deletionRequestedAt!.toISOString(),
      });
    } catch (err) {
      next(err);
    }
  }

  private async registerDevice(req: Request, res: Response, next: NextFunction) {
    try {
      const body = req.body as z.infer<typeof AuthSchemas.deviceBody>;
      await this.devices.register(req.user!.id, {
        fcmToken: body.fcm_token,
        platform: body.platform,
        appVersion: body.app_version,
      });
      return HttpResponse.noContent(res);
    } catch (err) {
      next(err);
    }
  }

  private async removeDevice(req: Request, res: Response, next: NextFunction) {
    try {
      await this.devices.remove(req.user!.id, req.params.fcm_token);
      return HttpResponse.noContent(res);
    } catch (err) {
      next(err);
    }
  }
}
