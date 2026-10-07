import * as Sentry from '@sentry/node';
import { env } from './config/env.config';

/**
 * Error tracking. Imported at the very top of src/index.ts so Sentry is set up before anything else
 * loads. Without `SENTRY_DSN` every Sentry call is a no-op.
 */
if (env.sentryDsn) {
  Sentry.init({
    dsn: env.sentryDsn,
    environment: env.nodeEnv,
    // Errors only for now; performance tracing can be enabled later.
    tracesSampleRate: 0,
    // Medical platform (spec §9): the SDK collects all of this by default — turn every category off so
    // no patient data, tokens or phone numbers leave through error reports. Add context explicitly instead.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
    },
  });
}
