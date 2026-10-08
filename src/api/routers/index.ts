import { type Router } from 'express';
import { accountDeletionRouter } from './account-deletion/account-deletion.router';

/**
 * Standalone routers that don't fit the controller pattern (file uploads, static pages, webhooks).
 * Mounted under the API prefix next to the controllers.
 */
export const standaloneRouters: Array<{ path: string; router: Router }> = [
  // GET /account-deletion (+ app.js): the web page Google Play links to for deleting an account.
  { path: '', router: accountDeletionRouter },
];
