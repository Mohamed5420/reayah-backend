import { describe, expect, it } from 'vitest';
import { Container } from 'typedi';
import { Types } from 'mongoose';
import { useTestDatabase } from '../helpers/db';
import { SettingsService } from '../../src/services/settings';
import { AuditLogModel } from '../../src/database/models/audit-log/audit-log.model';
import { getRedis } from '../../src/config/redis.config';

useTestDatabase();
const settings = Container.get(SettingsService);
const admin = { actorId: new Types.ObjectId().toHexString(), ip: '10.0.0.1' };

describe('SettingsService', () => {
  it('returns spec defaults when nothing is overridden', async () => {
    const all = await settings.getAll();
    expect(all).toMatchObject({
      org_assign_deadline_minutes: 25,
      fallback_window_minutes: 20,
      direct_request_response_minutes: 3,
      on_time_grace_minutes: 15,
      cancellation_free_window_hours: 3,
      referral_reward: 5000,
      payout_day: 'thursday',
    });
  });

  it('applies updates immediately, despite a warm cache', async () => {
    await settings.getAll(); // warm the cache
    await settings.update({ fallback_window_minutes: 30 }, admin);
    expect(await settings.get('fallback_window_minutes')).toBe(30);
  });

  it('features can be sent partially; the other flags keep their values', async () => {
    await settings.update({ features: { card_payment: true } }, admin);
    expect(await settings.get('features')).toEqual({
      video_consult: false,
      card_payment: true,
      packages: false,
      clinic_visits: false,
    });
  });

  it('records every update in the audit log with before/after values', async () => {
    await settings.update({ commission_rate: 18 }, admin);
    const entry = await AuditLogModel.findOne({ action: 'settings.update' }).lean();
    expect(entry).toMatchObject({
      ip: '10.0.0.1',
      metadata: { changes: { commission_rate: { from: 15, to: 18 } } },
    });
  });

  it('rejects unknown keys and invalid values, all-or-nothing', async () => {
    await expect(
      settings.update(
        { fallback_window_minutes: 40, commission_rate: 150, nope: 1, features: { video_consult: 'yes' } },
        admin,
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      fields: {
        commission_rate: ['validation.invalid_value'],
        nope: ['validation.unknown_setting'],
        features: ['validation.invalid_value'],
      },
    });
    expect(await settings.get('fallback_window_minutes')).toBe(20);
  });

  it('keeps working when Redis is down', async () => {
    const redis = getRedis();
    const originalGet = redis.get.bind(redis);
    redis.get = () => Promise.reject(new Error('redis down'));
    try {
      expect(await settings.get('payout_day')).toBe('thursday');
    } finally {
      redis.get = originalGet;
    }
  });
});
