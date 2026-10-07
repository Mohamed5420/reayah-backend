import { type Router } from 'express';

/**
 * Standalone routers that don't fit the controller pattern (file uploads, static pages, webhooks).
 * Mounted under the API prefix next to the controllers.
 */
export const standaloneRouters: Array<{ path: string; router: Router }> = [];
