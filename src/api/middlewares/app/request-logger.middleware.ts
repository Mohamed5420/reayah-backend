import morgan from 'morgan';
import { logger } from '../../../utils/logger/winston';

export const RequestLoggerMiddleware = morgan(':method :url :status :response-time ms', {
  stream: { write: (line) => logger.http(line.trim()) },
});
