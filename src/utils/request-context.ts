import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

type RequestContext = { requestId: string };

const storage = new AsyncLocalStorage<RequestContext>();

/** Id of the request being handled, if any — picked up by the logger and error reporting. */
export const getRequestId = (): string | undefined => storage.getStore()?.requestId;

const HEADER = 'X-Request-Id';
const VALID_ID = /^[\w-]{8,128}$/;

/**
 * Gives every request an id (the caller's `X-Request-Id` if it looks sane, otherwise a new UUID),
 * echoes it in the response header, and makes it available to everything that runs for that request.
 */
export const RequestIdMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const incoming = req.header(HEADER);
  const requestId = incoming && VALID_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader(HEADER, requestId);
  storage.run({ requestId }, next);
};
