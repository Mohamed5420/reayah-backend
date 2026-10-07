import winston from 'winston';
import { getRequestId } from '../request-context';

const { combine, timestamp, printf, colorize, errors, json } = winston.format;
// staging and production: JSON to stdout only (the container runtime collects and rotates it).
const isDeployed = ['staging', 'production'].includes(process.env.NODE_ENV ?? '');

/** Tags every log line written while handling a request with that request's id. */
const withRequestId = winston.format((info) => {
  const requestId = getRequestId();
  if (requestId) info.requestId = requestId;
  return info;
});

const lineFormat = printf(
  ({ level, message, timestamp: ts, stack, requestId }) =>
    `${ts} [${level}]${requestId ? ` [${String(requestId).slice(0, 8)}]` : ''} ${stack ?? message}`,
);

const isTest = process.env.NODE_ENV === 'test';

/**
 * Production: one JSON object per line (for log aggregation). Development: readable colored lines.
 * Tests: errors only, console only — test workers must not all append to the same log files.
 */
export const logger = winston.createLogger({
  level: isTest ? 'error' : isDeployed ? 'info' : 'debug',
  format: combine(withRequestId(), errors({ stack: true }), timestamp()),
  transports: [
    new winston.transports.Console({
      format: isDeployed ? json() : combine(colorize(), lineFormat),
    }),
    ...(isTest || isDeployed
      ? []
      : [
          new winston.transports.File({ filename: 'logs/error.log', level: 'error', format: json() }),
          new winston.transports.File({ filename: 'logs/combined.log', format: json() }),
        ]),
  ],
});
