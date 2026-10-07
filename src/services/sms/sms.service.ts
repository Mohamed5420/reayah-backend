import { Service } from 'typedi';
import { env } from '../../config/env.config';
import { logger } from '../../utils/logger/winston';
import { ServiceUnavailableError } from '../../utils/types-errors';

export interface SmsProvider {
  send(phone: string, message: string): Promise<void>;
}

/**
 * Development driver: writes messages to the log instead of sending them, and keeps the last ones in
 * memory for tests. It refuses to run in production — OTP codes must never end up in production logs.
 */
export class LogSmsProvider implements SmsProvider {
  static readonly sent: Array<{ phone: string; message: string }> = [];

  async send(phone: string, message: string) {
    if (env.isProduction) {
      logger.error('SMS_DRIVER=log is not allowed in production; configure a real SMS provider');
      throw new ServiceUnavailableError();
    }
    LogSmsProvider.sent.push({ phone, message });
    if (LogSmsProvider.sent.length > 50) LogSmsProvider.sent.shift();
    logger.info(`[SMS → ${phone}] ${message}`);
  }
}

const providers: Record<string, () => SmsProvider> = {
  log: () => new LogSmsProvider(),
  // Add the local provider here once chosen (spec §12.1), e.g. `victorylink: () => new VictoryLinkProvider(...)`.
};

@Service()
export class SmsService {
  private readonly provider: SmsProvider = (providers[env.smsDriver] ?? providers.log)();

  send(phone: string, message: string) {
    return this.provider.send(phone, message);
  }
}
