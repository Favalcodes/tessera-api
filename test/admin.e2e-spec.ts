import type { INestApplication } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AuthService } from '../src/auth/auth.service';
import type { DB } from '../src/database/database.types';
import { RoundsService } from '../src/rounds/rounds.service';
import { createRoundWithCrashPoint } from './helpers/round-fixtures';
import { createTestApp, resetDatabase, uniqueEmail } from './helpers/test-app';

/**
 * The operator dashboard.
 *
 * The access tests matter more than the numbers: a read-only dashboard exposing
 * every player's balance and email is a finding, not a feature, and it is the
 * kind of endpoint that quietly ships unguarded.
 */
describe('Admin', () => {
  let app: INestApplication;
  let db: Kysely<DB>;
  let auth: AuthService;
  let rounds: RoundsService;

  const http = () => request(app.getHttpServer() as App);

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    db = ctx.db;
    auth = app.get(AuthService);
    rounds = app.get(RoundsService);
  });

  beforeEach(async () => {
    await resetDatabase(db);
  });

  afterAll(async () => {
    await app.close();
  });

  async function makePlayer() {
    return auth.register({
      email: uniqueEmail(),
      displayName: 'Ada',
      password: 'correct-horse-battery-staple',
    });
  }

  async function makeAdmin() {
    const registered = await makePlayer();
    await db.updateTable('users').set({ role: 'admin' }).where('id', '=', registered.user.id).execute();
    // The role travels in the access token, so a fresh one is needed.
    const refreshed = await auth.login({
      email: registered.user.email,
      password: 'correct-horse-battery-staple',
    });
    return refreshed;
  }

  describe('access', () => {
    it.each(['/admin/overview', '/admin/users', '/admin/distribution'])(
      'refuses %s without a token',
      async (path) => {
        await http().get(path).expect(401);
      },
    );

    it.each(['/admin/overview', '/admin/users', '/admin/distribution'])(
      'refuses %s to an ordinary player',
      async (path) => {
        const player = await makePlayer();
        await http().get(path).set('Authorization', `Bearer ${player.accessToken}`).expect(403);
      },
    );

    it('allows an admin', async () => {
      const admin = await makeAdmin();
      await http()
        .get('/admin/overview')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .expect(200);
    });

    it('does not let a player promote themselves through the API', async () => {
      const player = await makePlayer();

      // There is no endpoint that sets a role, so the only way in is the script.
      const attempts = [
        await http()
          .post('/auth/register')
          .send({
            email: uniqueEmail(),
            displayName: 'Ada',
            password: 'correct-horse-battery-staple',
            role: 'admin',
          }),
        await http().get('/admin/users').set('Authorization', `Bearer ${player.accessToken}`),
      ];

      // The registration is rejected outright for carrying an unknown field.
      expect(attempts[0]!.status).toBe(400);
      expect(attempts[1]!.status).toBe(403);
    });
  });

  describe('overview', () => {
    it('derives every figure from the ledger', async () => {
      const admin = await makeAdmin();
      const player = await makePlayer();
      const round = await createRoundWithCrashPoint(db, 20_000);
      await rounds.placeBet({
        userId: player.user.id,
        roundId: round.id,
        stakeMinor: 10_000,
        idempotencyKey: randomUUID(),
      });

      const res = await http()
        .get('/admin/overview')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .expect(200);

      // Two accounts granted 1000.00 each.
      expect(res.body.ledger.creditsInCirculation).toBe('2000.00');
      // One 100.00 stake sitting in escrow, unresolved.
      expect(res.body.ledger.exposure).toBe('100.00');
      // Nothing has been won or lost yet.
      expect(res.body.ledger.housePnl).toBe('0.00');
      expect(res.body.ledger.healthy).toBe(true);
      expect(res.body.ledger.globalPostingSum).toBe(0);
      expect(res.body.counts.users).toBe(2);
    });

    it('reports live exposure per round', async () => {
      const admin = await makeAdmin();
      const player = await makePlayer();
      const round = await createRoundWithCrashPoint(db, 20_000);
      await rounds.placeBet({
        userId: player.user.id,
        roundId: round.id,
        stakeMinor: 2_500,
        idempotencyKey: randomUUID(),
      });

      const res = await http()
        .get('/admin/overview')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .expect(200);

      const live = res.body.liveRounds.find((r: { id: string }) => r.id === round.id);
      expect(live.bets).toBe(1);
      expect(live.staked).toBe('25.00');
    });
  });

  describe('players', () => {
    it('lists players with balances read from the ledger', async () => {
      const admin = await makeAdmin();
      const player = await makePlayer();

      const res = await http()
        .get('/admin/users')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .expect(200);

      expect(res.body.total).toBe(2);
      const found = res.body.users.find((u: { id: string }) => u.id === player.user.id);
      expect(found.balance).toBe('1000.00');
      // Never expose credentials, however incidentally.
      expect(JSON.stringify(res.body)).not.toContain('password');
      expect(found.passwordHash).toBeUndefined();
    });

    it('searches by email', async () => {
      const admin = await makeAdmin();
      const player = await makePlayer();

      const res = await http()
        .get(`/admin/users?search=${player.user.email.split('@')[0]}`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .expect(200);

      expect(res.body.users).toHaveLength(1);
      expect(res.body.users[0].id).toBe(player.user.id);
    });

    it('buckets balances so an average cannot hide the shape', async () => {
      const admin = await makeAdmin();
      await makePlayer();

      const res = await http()
        .get('/admin/distribution')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .expect(200);

      const total = res.body.reduce(
        (sum: number, bucket: { players: number }) => sum + bucket.players,
        0,
      );
      expect(total).toBe(2);
    });
  });
});
