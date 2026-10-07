import { Router, type NextFunction, type Request, type Response } from 'express';
import { Container } from 'typedi';
import type IBaseController from '../interfaces/base-controller.interface';
import { AuthRateLimiterMiddleware, CheckAppStatusMiddleware } from '../../middlewares/app';
import { Auth } from '../../middlewares/auth';
import { AuthSchemas, parseDateOnly } from '../../validations/auth/auth.validation';
import type { z } from '../../validations/zod';
import { presentAuthUser, presentMe } from '../../presenters/user.presenter';
import { defineRoute } from '../../../docs/openapi';
import {
  LogoutUseCase,
  RegisterUseCase,
  RequestLoginOtpUseCase,
  RequestPhoneChangeUseCase,
  TokenService,
  VerifyLoginOtpUseCase,
  VerifyPhoneChangeUseCase,
} from '../../../services/auth';
import { UserService } from '../../../services/user';
import { auditContextFrom } from '../../../services/audit';
import { HttpResponse } from '../../../utils/response/http-response';
import { UnauthorizedError } from '../../../utils/types-errors';

const tags = ['Auth'];

const routes = {
  otpRequest: defineRoute({
    method: 'post',
    path: '/auth/otp/request',
    summary: 'Send a login code by SMS. Limits: 1/min and 3/10 min per phone, 10/hour per IP.',
    tags,
    request: { body: AuthSchemas.otpRequestBody },
    response: { schema: AuthSchemas.otpSent },
  }),
  otpVerify: defineRoute({
    method: 'post',
    path: '/auth/otp/verify',
    summary: 'Verify the code: a session for existing users, a registration token for new numbers',
    tags,
    request: { body: AuthSchemas.otpVerifyBody },
    response: { schema: AuthSchemas.otpVerified },
  }),
  register: defineRoute({
    method: 'post',
    path: '/auth/register',
    summary: 'Finish sign-up. Authorization: Bearer <registration_token> (from /auth/otp/verify)',
    tags,
    auth: true,
    request: { body: AuthSchemas.registerBody },
    response: { status: 201, schema: AuthSchemas.session },
  }),
  refresh: defineRoute({
    method: 'post',
    path: '/auth/refresh',
    summary:
      'Exchange a refresh token for a new pair. Each refresh token works once — never refresh in parallel.',
    tags,
    request: { body: AuthSchemas.refreshBody },
    response: { schema: AuthSchemas.tokens },
  }),
  logout: defineRoute({
    method: 'post',
    path: '/auth/logout',
    summary: 'End this session (and unregister the device push token if given)',
    tags,
    request: { body: AuthSchemas.logoutBody },
    response: { status: 204 },
  }),
  phoneChangeRequest: defineRoute({
    method: 'post',
    path: '/auth/phone/change/request',
    summary: 'Send a code to the new phone number',
    tags,
    auth: true,
    request: { body: AuthSchemas.phoneChangeRequestBody },
    response: { schema: AuthSchemas.otpSent },
  }),
  phoneChangeVerify: defineRoute({
    method: 'post',
    path: '/auth/phone/change/verify',
    summary: 'Confirm the code and switch the account to the new number',
    tags,
    auth: true,
    request: { body: AuthSchemas.phoneChangeVerifyBody },
    response: { schema: AuthSchemas.me },
  }),
};

/** Phone + OTP authentication (spec §7.1). No passwords anywhere. */
export default class AuthController implements IBaseController {
  path = '/auth';
  router = Router();

  private requestOtp = Container.get(RequestLoginOtpUseCase);
  private verifyOtp = Container.get(VerifyLoginOtpUseCase);
  private registerUser = Container.get(RegisterUseCase);
  private tokens = Container.get(TokenService);
  private logoutUser = Container.get(LogoutUseCase);
  private requestPhoneChange = Container.get(RequestPhoneChangeUseCase);
  private verifyPhoneChange = Container.get(VerifyPhoneChangeUseCase);
  private users = Container.get(UserService);

  constructor() {
    this.initializeRoutes();
  }

  initializeRoutes() {
    const publicRoutes = [
      [routes.otpRequest, this.otpRequest],
      [routes.otpVerify, this.otpVerify],
      [routes.register, this.register], // authenticated by the registration token, not an access token
      [routes.refresh, this.refresh],
      [routes.logout, this.logout],
    ] as const;
    for (const [route, handler] of publicRoutes) {
      this.router.post(
        route.path,
        CheckAppStatusMiddleware,
        AuthRateLimiterMiddleware,
        route.validate,
        handler.bind(this),
      );
    }

    for (const [route, handler] of [
      [routes.phoneChangeRequest, this.phoneChangeRequest],
      [routes.phoneChangeVerify, this.phoneChangeVerify],
    ] as const) {
      this.router.post(route.path, CheckAppStatusMiddleware, route.validate, ...Auth(), handler.bind(this));
    }
  }

  private async otpRequest(req: Request, res: Response, next: NextFunction) {
    try {
      return HttpResponse.ok(res, await this.requestOtp.execute(req.body.phone, clientIp(req)));
    } catch (err) {
      next(err);
    }
  }

  private async otpVerify(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await this.verifyOtp.execute(req.body.phone, req.body.code);
      return HttpResponse.ok(
        res,
        result.isNewUser
          ? { is_new_user: true, registration_token: result.registrationToken }
          : { is_new_user: false, ...result.tokens, user: presentAuthUser(result.user) },
      );
    } catch (err) {
      next(err);
    }
  }

  private async register(req: Request, res: Response, next: NextFunction) {
    try {
      const header = req.headers.authorization;
      if (!header?.startsWith('Bearer ')) throw new UnauthorizedError('errors.invalid_registration_token');
      const body = req.body as z.infer<typeof AuthSchemas.registerBody>;
      const { user, tokens } = await this.registerUser.execute(header.slice(7), {
        role: body.role,
        fullName: body.full_name,
        gender: body.gender,
        dateOfBirth: parseDateOnly(body.date_of_birth),
        email: body.email,
        language: body.language,
        referralCode: body.referral_code,
      });
      return HttpResponse.created(res, { ...tokens, user: presentAuthUser(user) });
    } catch (err) {
      next(err);
    }
  }

  private async refresh(req: Request, res: Response, next: NextFunction) {
    try {
      return HttpResponse.ok(res, await this.tokens.rotate(req.body.refresh_token));
    } catch (err) {
      next(err);
    }
  }

  private async logout(req: Request, res: Response, next: NextFunction) {
    try {
      await this.logoutUser.execute(req.body.refresh_token, req.body.fcm_token);
      return HttpResponse.noContent(res);
    } catch (err) {
      next(err);
    }
  }

  private async phoneChangeRequest(req: Request, res: Response, next: NextFunction) {
    try {
      return HttpResponse.ok(
        res,
        await this.requestPhoneChange.execute(req.user!.id, req.body.new_phone, clientIp(req)),
      );
    } catch (err) {
      next(err);
    }
  }

  private async phoneChangeVerify(req: Request, res: Response, next: NextFunction) {
    try {
      await this.verifyPhoneChange.execute(
        req.user!.id,
        req.body.new_phone,
        req.body.code,
        auditContextFrom(req),
      );
      const me = await this.users.getMe(req.user!.id);
      return HttpResponse.ok(res, presentMe(me));
    } catch (err) {
      next(err);
    }
  }
}

/** With `trust proxy` set, `req.ip` is the client's address, not the load balancer's. */
const clientIp = (req: Request) => req.ip ?? 'unknown';
