import type { INestApplication } from '@nestjs/common';
import type { Kysely } from 'kysely';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { DB } from '../src/database/schema';
import { createTestApp, resetDatabase, uniqueEmail } from './helpers/test-app';

/**
 * The other auth specs disable rate limiting so they can register freely. This
 * one leaves it on, so the limiter cannot silently stop working without a test
 * noticing — a protection that is disabled in every test is not a protection.
 */
describe('Auth rate limiting', () => {
  let app: INestApplication;
  let db: Kysely<DB>;

  const http = () => request(app.getHttpServer() as App);

  beforeAll(async () => {
    const ctx = await createTestApp({ throttle: true });
    app = ctx.app;
    db = ctx.db;
    await resetDatabase(db);
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects registration attempts beyond the per-minute limit', async () => {
    const statuses: number[] = [];

    // The configured limit is 5/minute; the sixth attempt must be refused.
    for (let i = 0; i < 7; i += 1) {
      const res = await http()
        .post('/auth/register')
        .send({
          email: uniqueEmail(),
          displayName: 'Ada',
          password: 'correct-horse-battery-staple',
        });
      statuses.push(res.status);
    }

    expect(statuses.filter((s) => s === 201)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  });
});
