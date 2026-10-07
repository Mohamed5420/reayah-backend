import type { Express } from 'express';
import swaggerUi from 'swagger-ui-express';
import { buildOpenApiDocument } from './openapi';

/** Swagger UI at `/docs` and the raw spec at `/docs/openapi.json`. Mounted outside production only. */
export const mountApiDocs = (app: Express) => {
  app.get('/docs/openapi.json', (_req, res) => {
    res.json(buildOpenApiDocument());
  });
  app.use(
    '/docs',
    swaggerUi.serve,
    swaggerUi.setup(undefined, { swaggerOptions: { url: '/docs/openapi.json' } }),
  );
};
