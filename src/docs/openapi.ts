import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import type { RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { z } from '../api/validations/zod';
import { validate, type RequestSchemas } from '../api/validations/validate';
import { env } from '../config/env.config';

/**
 * OpenAPI spec generated from the same zod schemas that validate requests (spec §3 "OpenAPI from code").
 * Routes register themselves through `defineRoute()` when their controller is constructed.
 */
const registry = new OpenAPIRegistry();

const bearerAuth = registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
});

const ErrorEnvelope = registry.register(
  'Error',
  z.object({
    error: z.object({
      code: z.string().openapi({ example: 'VALIDATION_ERROR' }),
      message: z.string().openapi({ example: 'بيانات غير صالحة' }),
      fields: z.record(z.string(), z.array(z.string())).optional(),
    }),
  }),
);

const PaginationMeta = registry.register(
  'PaginationMeta',
  z.object({ page: z.number(), per_page: z.number(), total: z.number(), last_page: z.number() }),
);

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

export type RouteSpec = {
  method: Method;
  /** Express-style path relative to the API prefix, e.g. `/users/:id`. */
  path: string;
  summary: string;
  tags: string[];
  /** Requires `Authorization: Bearer`. */
  auth?: boolean;
  /** Requires an `Idempotency-Key` header (add `IdempotencyMiddleware` to the route as well). */
  idempotent?: boolean;
  request?: RequestSchemas;
  /**
   * multipart/form-data upload: `field` is the file (documented as binary, handled by `UploadMiddleware`);
   * `request.body` validates the accompanying text fields. Mount `r.validate` *after* the upload middleware.
   */
  upload?: { field: string };
  response?: {
    /** Defaults to 200. */
    status?: 200 | 201 | 202 | 204;
    /** Shape of `data`. Omit for 204. */
    schema?: ZodType;
    /** `data` is a list and `meta` carries pagination. */
    paginated?: boolean;
    description?: string;
  };
};

export type DefinedRoute = {
  method: Method;
  /** Express path to mount the handler on. */
  path: string;
  /** Request validation built from `request`; put it where validators go in the middleware chain. */
  validate: RequestHandler;
};

const toOpenApiPath = (path: string) => `${env.apiPrefix}${path}`.replace(/:(\w+)/g, '{$1}');

/** Documents a route and returns its validator, so docs and validation can't drift apart. */
export const defineRoute = (spec: RouteSpec): DefinedRoute => {
  const { status = 200, schema, paginated, description = 'Success' } = spec.response ?? {};
  const dataSchema = schema && paginated ? z.array(schema) : schema;
  const envelope = paginated
    ? z.object({ data: dataSchema ?? z.array(z.unknown()), meta: PaginationMeta })
    : z.object({ data: dataSchema ?? z.unknown() });

  registry.registerPath({
    method: spec.method,
    path: toOpenApiPath(spec.path),
    summary: spec.summary,
    tags: spec.tags,
    security: spec.auth ? [{ [bearerAuth.name]: [] }] : undefined,
    request: {
      params: spec.request?.params as never,
      query: spec.request?.query as never,
      headers: spec.idempotent ? z.object({ 'Idempotency-Key': z.uuid() }) : undefined,
      body: spec.upload
        ? {
            content: {
              'multipart/form-data': {
                schema: ((spec.request?.body as z.ZodObject | undefined) ?? z.object({})).extend({
                  [spec.upload.field]: z.string().openapi({ type: 'string', format: 'binary' }),
                }),
              },
            },
          }
        : spec.request?.body
          ? { content: { 'application/json': { schema: spec.request.body } } }
          : undefined,
    },
    responses: {
      [status]:
        status === 204
          ? { description }
          : { description, content: { 'application/json': { schema: envelope } } },
      default: {
        description: 'Error (see `error.code`)',
        content: { 'application/json': { schema: ErrorEnvelope } },
      },
    },
  });

  return { method: spec.method, path: spec.path, validate: validate(spec.request ?? {}) };
};

export const buildOpenApiDocument = () =>
  new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Reaya+ API',
      version: '1.0.0',
      description:
        'Reaya+ backend API. Responses use `{ data, meta? }`; errors use `{ error: { code, message, fields? } }`. ' +
        'Messages are Arabic (`Accept-Language: ar`).',
    },
    servers: [{ url: '/' }],
  });
