import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GlobalErrorHandlerMiddleware, IdempotencyMiddleware } from '../../src/api/middlewares/app';
import { getRedis } from '../../src/config/redis.config';

let runs = 0;
const app = express();
app.use(express.json());
app.post('/bookings', IdempotencyMiddleware, async (req, res) => {
  runs++;
  if (req.body.slow) await new Promise((resolve) => setTimeout(resolve, 300));
  if (req.body.fail) return res.status(500).json({ error: 'boom' });
  res.status(201).json({ data: { run: runs } });
});
app.use(GlobalErrorHandlerMiddleware);

const post = (key: string | undefined, body: object) => {
  const req = request(app).post('/bookings').send(body);
  return key ? req.set('Idempotency-Key', key) : req;
};

describe('IdempotencyMiddleware', () => {
  beforeEach(() => {
    runs = 0;
  });
  afterEach(async () => {
    await getRedis().flushall();
  });

  it('replays the stored response instead of running twice', async () => {
    const key = randomUUID();
    const first = await post(key, { a: 1 });
    const second = await post(key, { a: 1 });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(runs).toBe(1);
  });

  it('rejects the same key with a different body', async () => {
    const key = randomUUID();
    await post(key, { a: 1 });
    const res = await post(key, { a: 2 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it.each([[undefined], ['not-a-uuid']])('requires a UUID key (%s)', async (key) => {
    const res = await post(key, { a: 1 });
    expect(res.status).toBe(422);
    expect(res.body.error.fields['Idempotency-Key']).toBeDefined();
  });

  it('answers 409 while the first request is still running', async () => {
    const key = randomUUID();
    const first = post(key, { slow: true }).then((r) => r);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await post(key, { slow: true });

    expect(second.status).toBe(409);
    expect((await first).status).toBe(201);
    expect(runs).toBe(1);
  });

  it('does not store 5xx responses, so a retry runs again', async () => {
    const key = randomUUID();
    await post(key, { fail: true });
    await new Promise((resolve) => setTimeout(resolve, 20)); // let the finish handler clear the key
    await post(key, { fail: true });
    expect(runs).toBe(2);
  });
});
