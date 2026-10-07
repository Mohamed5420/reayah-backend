import type { NextFunction, Request, Response } from 'express';

/**
 * Lets clients and CDNs cache public lookup responses (spec §7.3 "public, cacheable").
 * Responses are localized, so caches must key on `Accept-Language`.
 */
export const PublicCacheMiddleware =
  (maxAgeSeconds = 300) =>
  (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', `public, max-age=${maxAgeSeconds}`);
    res.setHeader('Vary', 'Accept-Language');
    next();
  };
