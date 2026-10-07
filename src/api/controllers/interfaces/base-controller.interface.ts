import type { Router } from 'express';

export default interface IBaseController {
  path: string;
  secondPath?: string; // optional: one controller serving two base paths
  router: Router;
  initializeRoutes(): void;
}
