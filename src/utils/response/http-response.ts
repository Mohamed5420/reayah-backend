import type { Response } from 'express';
import { buildPaginationMeta, type Pagination } from './pagination';

/** Success envelope (spec §7.0): `{ data, meta? }`. Errors are shaped by the global error handler. */
export class HttpResponse {
  static ok<T>(res: Response, data: T, meta?: Record<string, unknown>) {
    return res.status(200).json(meta ? { data, meta } : { data });
  }

  static created<T>(res: Response, data: T) {
    return res.status(201).json({ data });
  }

  /** For requests that were accepted but finish later (e.g. scheduled account deletion). */
  static accepted<T>(res: Response, data: T) {
    return res.status(202).json({ data });
  }

  static paginated<T>(res: Response, data: T[], pagination: Pagination, total: number) {
    return res.status(200).json({ data, meta: buildPaginationMeta(pagination, total) });
  }

  static noContent(res: Response) {
    return res.status(204).send();
  }
}
