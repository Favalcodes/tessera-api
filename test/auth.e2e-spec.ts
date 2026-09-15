import type { INestApplication } from '@nestjs/common';
import type { Kysely } from 'kysely';
import request from 'supertest';
import type { App } from 'supertest/types';
import { Money } from '../src/common/money';
import { SYSTEM_ACCOUNTS, type DB } from '../src/database/schema';
import { LedgerService } from '../src/ledger/ledger.service';
import { createTestApp, resetDatabase, uniqueEmail } from './helpers/test-app';

const PASSWORD = 'correct-horse-battery-staple';
const GRANT_MINOR = 100_000; // 1000.00

describe('Auth and the signup grant', () => {
  let app: INestApplication;
  let db: Kysely<DB>;
  let ledger: LedgerService;

  const http = () => request(app.getHttpServer() as App);

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    db = ctx.db;
    ledger = app.get(LedgerService);
  });

  beforeEach(async () => {
    await resetDatabase(db);
  });

  afterAll(async () => {
    await app.close();
  });

  const register = (email = uniqueEmail()) =>
    http().post('/auth/register').send({ email, displayName: 'Ada', password: PASSWORD });

  describe('registration', () => {
    it('creates the account, wallet and opening grant atomically', async () => {
      const res = await register().expect(201);

      expect(res.body.accessToken).toBeDefined();
      expect(res.body.refreshToken).toBeDefined();
      expect(res.body.user.displayName).toBe('Ada');
      // The password must never come back, in any form.
      expect(JSON.stringify(res.body)).not.toContain(PASSWORD);
      expect(res.body.user.passwordHash).toBeUndefined();

      const balance = await ledger.getUserBalance(String(res.body.user.id));
      expect(balance).toBe(GRANT_MINOR);
      expect(Money.format(balance)).toBe('1000.00');
    });

    it('funds the grant from MINT, so the books still balance', async () => {
      await register().expect(201);

      expect(await ledger.getGlobalSum()).toBe(0);
      expect(await ledger.findBalanceDrift()).toEqual([]);
      expect(await ledger.getBalance(SYSTEM_ACCOUNTS.MINT)).toBe(-GRANT_MINOR);
      expect(await ledger.getCreditsInCirculation()).toBe(GRANT_MINOR);
    });

    it('records the grant as an ordinary ledger entry, visible in history', async () => {
      const res = await register().expect(201);

      const history = await http()
        .get('/me/ledger')
        .set('Authorization', `Bearer ${res.body.accessToken}`)
        .expect(200);

      expect(history.body.entries).toHaveLength(1);
      expect(history.body.entries[0]).toMatchObject({
        kind: 'SIGNUP_GRANT',
        amountMinor: GRANT_MINOR,
        direction: 'credit',
        referenceType: 'user',
      });
    });

    it('rejects a duplicate email', async () => {
      const email = uniqueEmail();
      await register(email).expect(201);
      const res = await register(email).expect(409);
      expect(res.body.error).toBe('EmailAlreadyRegisteredError');
    });

    it('rejects a short password', async () => {
      await http()
        .post('/auth/register')
        .send({ email: uniqueEmail(), displayName: 'Ada', password: 'short' })
        .expect(400);
    });

    it('strips unknown fields rather than trusting them', async () => {
      const res = await http()
        .post('/auth/register')
        .send({ email: uniqueEmail(), displayName: 'Ada', password: PASSWORD, role: 'admin' })
        .expect(400); // forbidNonWhitelisted: an unexpected field is a client bug

      expect(res.body.message).toMatch(/role/);
    });
  });

  describe('login', () => {
    it('issues tokens for valid credentials', async () => {
      const email = uniqueEmail();
      await register(email).expect(201);

      const res = await http().post('/auth/login').send({ email, password: PASSWORD }).expect(200);
      expect(res.body.accessToken).toBeDefined();
    });

    it('rejects a wrong password', async () => {
      const email = uniqueEmail();
      await register(email).expect(201);

      await http().post('/auth/login').send({ email, password: 'wrong-password-here' }).expect(401);
    });

    it('gives the same response for an unknown account as for a wrong password', async () => {
      const unknown = await http()
        .post('/auth/login')
        .send({ email: uniqueEmail(), password: PASSWORD })
        .expect(401);

      const email = uniqueEmail();
      await register(email).expect(201);
      const wrong = await http()
        .post('/auth/login')
        .send({ email, password: 'wrong-password-here' })
        .expect(401);

      // Identical messages: the response must not reveal whether the address exists.
      expect(unknown.body.message).toBe(wrong.body.message);
    });
  });

  describe('refresh rotation and reuse detection', () => {
    it('rotates the refresh token, invalidating the old one', async () => {
      const res = await register().expect(201);
      const first = res.body.refreshToken;

      const rotated = await http().post('/auth/refresh').send({ refreshToken: first }).expect(200);
      expect(rotated.body.refreshToken).not.toBe(first);

      // The rotated token works.
      await http()
        .post('/auth/refresh')
        .send({ refreshToken: rotated.body.refreshToken })
        .expect(200);
    });

    it('detects reuse of a spent token and revokes the entire family', async () => {
      const res = await register().expect(201);
      const first = res.body.refreshToken;

      const second = await http()
        .post('/auth/refresh')
        .send({ refreshToken: first })
        .expect(200);
      const third = await http()
        .post('/auth/refresh')
        .send({ refreshToken: second.body.refreshToken })
        .expect(200);

      // Replaying the spent first token is the attack signature.
      const replay = await http().post('/auth/refresh').send({ refreshToken: first }).expect(401);
      expect(replay.body.error).toBe('RefreshTokenReuseError');

      // And the currently-valid token is now dead too: the whole family is gone.
      await http()
        .post('/auth/refresh')
        .send({ refreshToken: third.body.refreshToken })
        .expect(401);
    });

    it('rejects a garbage refresh token', async () => {
      await http().post('/auth/refresh').send({ refreshToken: 'not-a-token' }).expect(401);
    });

    it('revokes the family on logout', async () => {
      const res = await register().expect(201);

      await http().post('/auth/logout').send({ refreshToken: res.body.refreshToken }).expect(204);
      await http()
        .post('/auth/refresh')
        .send({ refreshToken: res.body.refreshToken })
        .expect(401);
    });
  });

  describe('protected routes', () => {
    it('refuses an unauthenticated request', async () => {
      await http().get('/me/balance').expect(401);
    });

    it('refuses a malformed bearer token', async () => {
      await http().get('/me/balance').set('Authorization', 'Bearer nonsense').expect(401);
    });

    it('serves the balance for an authenticated user', async () => {
      const res = await register().expect(201);

      const balance = await http()
        .get('/me/balance')
        .set('Authorization', `Bearer ${res.body.accessToken}`)
        .expect(200);

      expect(balance.body).toEqual({ balanceMinor: GRANT_MINOR, balance: '1000.00' });
    });
  });

  describe('health', () => {
    it('reports ledger integrity', async () => {
      await register().expect(201);

      const res = await http().get('/health/ledger').expect(200);
      expect(res.body).toMatchObject({
        status: 'ok',
        globalPostingSum: 0,
        driftingAccounts: 0,
        creditsInCirculation: '1000.00',
      });
    });
  });
});
