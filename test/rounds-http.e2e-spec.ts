import type { INestApplication } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { DB } from '../src/database/database.types';
import { RoundsService } from '../src/rounds/rounds.service';
import { advanceToCrash, createRoundWithCrashPoint, launchRound } from './helpers/round-fixtures';
import { createTestApp, resetDatabase, uniqueEmail } from './helpers/test-app';

/**
 * The HTTP surface of betting.
 *
 * These exist because a refusal reaching a client as a 500 is a bug even when
 * the refusal itself is correct — it tells the client nothing, is unretryable by
 * any sensible rule, and makes a working system look broken. Every domain error
 * on this path must arrive as a status the client can act on. The gap was real:
 * a late cash-out returned 500 until these were written.
 */
describe('Rounds over HTTP: status codes', () => {
  let app: INestApplication;
  let db: Kysely<DB>;
  let rounds: RoundsService;

  const http = () => request(app.getHttpServer() as App);

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    db = ctx.db;
    rounds = app.get(RoundsService);
  });

  beforeEach(async () => {
    await resetDatabase(db);
  });

  afterAll(async () => {
    await app.close();
  });

  async function register() {
    const res = await http()
      .post('/auth/register')
      .send({ email: uniqueEmail(), displayName: 'Ada', password: 'correct-horse-battery-staple' })
      .expect(201);
    return { token: res.body.accessToken as string, userId: res.body.user.id as string };
  }

  it('404s when nothing is running', async () => {
    const res = await http().get('/rounds/current').expect(404);
    expect(res.body.error).toBe('NoActiveRoundError');
  });

  it('409s a bet placed after betting closed', async () => {
    const { token } = await register();
    const round = await createRoundWithCrashPoint(db, 20_000);
    await launchRound(db, round.id);

    const res = await http()
      .post(`/rounds/${round.id}/bets`)
      .set('Authorization', `Bearer ${token}`)
      .send({ stakeMinor: 1_000, idempotencyKey: randomUUID() })
      .expect(409);

    expect(res.body.error).toBe('RoundNotOpenError');
  });

  it('409s a cash-out that arrives after the crash', async () => {
    const { token, userId } = await register();
    const round = await createRoundWithCrashPoint(db, 20_000);
    const bet = await rounds.placeBet({
      userId,
      roundId: round.id,
      stakeMinor: 1_000,
      idempotencyKey: randomUUID(),
    });
    await launchRound(db, round.id);
    await advanceToCrash(db, round.id, round.crashPointBp);

    const res = await http()
      .post(`/rounds/bets/${bet.id}/cashout`)
      .set('Authorization', `Bearer ${token}`)
      .send({ idempotencyKey: randomUUID() })
      .expect(409);

    expect(res.body.error).toBe('CashOutTooLateError');
    expect(res.body.message).toMatch(/too late/i);
  });

  it('400s a stake outside the allowed range', async () => {
    const { token } = await register();
    const round = await createRoundWithCrashPoint(db, 20_000);

    const res = await http()
      .post(`/rounds/${round.id}/bets`)
      .set('Authorization', `Bearer ${token}`)
      .send({ stakeMinor: 1, idempotencyKey: randomUUID() })
      .expect(400);

    expect(res.body.error).toBe('StakeOutOfRangeError');
  });

  it('409s a bet the balance cannot cover', async () => {
    const { token } = await register();
    const round = await createRoundWithCrashPoint(db, 20_000);

    const res = await http()
      .post(`/rounds/${round.id}/bets`)
      .set('Authorization', `Bearer ${token}`)
      .send({ stakeMinor: 999_999, idempotencyKey: randomUUID() })
      .expect(409);

    expect(res.body.error).toBe('InsufficientFundsError');
  });

  it('404s a cash-out against a bet that is not yours', async () => {
    const mine = await register();
    const theirs = await register();
    const round = await createRoundWithCrashPoint(db, 500_000);
    const bet = await rounds.placeBet({
      userId: theirs.userId,
      roundId: round.id,
      stakeMinor: 1_000,
      idempotencyKey: randomUUID(),
    });
    await launchRound(db, round.id);

    const res = await http()
      .post(`/rounds/bets/${bet.id}/cashout`)
      .set('Authorization', `Bearer ${mine.token}`)
      .send({ idempotencyKey: randomUUID() })
      .expect(404);

    expect(res.body.error).toBe('NoBetOnRoundError');
  });

  it('404s an unknown round', async () => {
    const { token } = await register();
    const res = await http()
      .post(`/rounds/${randomUUID()}/bets`)
      .set('Authorization', `Bearer ${token}`)
      .send({ stakeMinor: 1_000, idempotencyKey: randomUUID() })
      .expect(404);

    expect(res.body.error).toBe('RoundNotFoundError');
  });

  it('never answers a well-formed request with a 500', async () => {
    const { token, userId } = await register();
    const round = await createRoundWithCrashPoint(db, 20_000);
    const bet = await rounds.placeBet({
      userId,
      roundId: round.id,
      stakeMinor: 1_000,
      idempotencyKey: randomUUID(),
    });
    await launchRound(db, round.id);
    await advanceToCrash(db, round.id, round.crashPointBp);

    // Every one of these is a legitimate request the current state refuses.
    // Sequential rather than parallel: supertest binds an ephemeral listener per
    // request, and firing them together makes them race for it.
    const attempts = [
      await http().get('/rounds/current'),
      await http().get(`/rounds/${round.id}`),
      await http()
        .post(`/rounds/${round.id}/bets`)
        .set('Authorization', `Bearer ${token}`)
        .send({ stakeMinor: 1_000, idempotencyKey: randomUUID() }),
      await http()
        .post(`/rounds/bets/${bet.id}/cashout`)
        .set('Authorization', `Bearer ${token}`)
        .send({ idempotencyKey: randomUUID() }),
    ];

    for (const attempt of attempts) {
      expect(attempt.status).toBeLessThan(500);
    }
  });
});
