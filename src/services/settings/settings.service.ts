import { Container, Service } from 'typedi';
import { Types } from 'mongoose';
import { SettingModel } from '../../database/models/setting/setting.model';
import { getRedis } from '../../config/redis.config';
import { ValidationError, type ErrorFields } from '../../utils/types-errors';
import { logger } from '../../utils/logger/winston';
import { AuditService, type AuditContext } from '../audit/audit.service';
import {
  SETTING_DEFAULTS,
  SETTING_VALIDATORS,
  isSettingKey,
  type SettingKey,
  type Settings,
} from './settings.definitions';

const CACHE_KEY = 'settings:v1';
const CACHE_TTL_SECONDS = 300;

/**
 * Typed access to platform settings: defaults from code, overridden by admin values stored in Mongo,
 * cached in Redis (dropped on every update). If Redis is down, reads go straight to Mongo.
 */
@Service()
export class SettingsService {
  private readonly audit = Container.get(AuditService);

  async get<K extends SettingKey>(key: K): Promise<Settings[K]> {
    return (await this.getAll())[key];
  }

  async getAll(): Promise<Settings> {
    const cached = await this.readCache();
    if (cached) return cached;

    const settings = { ...SETTING_DEFAULTS };
    const overrides = await SettingModel.find().lean();
    for (const { key, value } of overrides) {
      // Skip keys that no longer exist and values that no longer pass validation.
      if (isSettingKey(key) && SETTING_VALIDATORS[key](value)) {
        (settings as Record<SettingKey, unknown>)[key] = value;
      } else {
        logger.warn(`Ignoring invalid stored setting "${key}"`);
      }
    }

    await this.writeCache(settings);
    return settings;
  }

  /** Validates every change first (all-or-nothing), saves, drops the cache and writes an audit entry. */
  async update(changes: Record<string, unknown>, context: AuditContext): Promise<Settings> {
    const fields: ErrorFields = {};
    for (const [key, value] of Object.entries(changes)) {
      if (!isSettingKey(key)) fields[key] = ['validation.unknown_setting'];
      else if (!SETTING_VALIDATORS[key](value)) fields[key] = ['validation.invalid_value'];
    }
    if (Object.keys(fields).length) throw new ValidationError(fields);

    const previous = await this.getAll();
    await SettingModel.bulkWrite(
      Object.entries(changes).map(([key, value]) => ({
        updateOne: {
          filter: { key },
          update: {
            $set: { value, updatedBy: context.actorId ? new Types.ObjectId(context.actorId) : null },
          },
          upsert: true,
        },
      })),
    );
    await this.dropCache();

    await this.audit.log(context, {
      action: 'settings.update',
      entityType: 'settings',
      metadata: {
        changes: Object.fromEntries(
          Object.entries(changes).map(([key, value]) => [
            key,
            { from: previous[key as SettingKey], to: value },
          ]),
        ),
      },
    });

    return this.getAll();
  }

  private async readCache(): Promise<Settings | null> {
    try {
      const raw = await getRedis().get(CACHE_KEY);
      return raw ? (JSON.parse(raw) as Settings) : null;
    } catch (err) {
      logger.warn('Settings cache read failed, falling back to Mongo', err);
      return null;
    }
  }

  private async writeCache(settings: Settings) {
    try {
      await getRedis().set(CACHE_KEY, JSON.stringify(settings), 'EX', CACHE_TTL_SECONDS);
    } catch (err) {
      logger.warn('Settings cache write failed', err);
    }
  }

  /** Must succeed: a stale cache would keep serving the old values to every instance. */
  private async dropCache() {
    await getRedis().del(CACHE_KEY);
  }
}
