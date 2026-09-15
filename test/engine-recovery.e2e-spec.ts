import type { INestApplication } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { randomUUID } from 'node:crypto';
import { AuthService } from '../src/auth/auth.service';
import { SYSTEM_ACCOUNTS, type DB } from '../src/database/database.types';
import { LedgerService } from '../src/ledger/ledger.service';
import { RoundsService } from '../src/rounds/rounds.service';
import {
  advanceToCrash,
  createRoundWithCrashPoint,
  engine,
  launchRound,
  setElapsed,
} from './helpers/round-fixtures';
import { createTestApp, resetDatabase, uniqueEmail } from './helpers/test-app';

const GRANT = 100_000;
const STAKE = 10_000;

/**
 * What happens when the engine stops running mid-round.
 *
 * Before this existed, an outage was silently charged to the players: on
 * restart the round was long past its crash point, got resolved normally, and
 * every still-active bet was written off as lost — for a round nobody had any
 * opportunity to cash out of. The stakes are refunded now.
 */
describe('Engine recovery after an outage', () => {
  let app: INestApplication;
  let db: Kysely<DB>;
  let rounds: RoundsService;
  let ledger: LedgerService;
  let auth: AuthService;

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    db = ctx.db;
    rounds = app.get(RoundsService);
    ledger = app.get(LedgerService);
    auth = app.get(AuthService);
  });

  beforeEach(async () => {
    await resetDatabase(db);
  });

  afterAll(async () => {
    await app.close();
  });

  async function makeUser(): Promise<string> {
    const result = await auth.register({
      email: uniqueEmail(),
      displayName: 'Ada',
      password: 'correct-horse-battery-staple',
    });
    return result.user.id;
  }

  async function expectLedgerIntact() {
    expect(await ledger.getGlobalSum()).toBe(0);
    expect(await ledger.findBalanceDrift()).toEqual([]);
  }

  it('refunds every stake when a round is found long past its crash point', async () => {
    const userId = await makeUser();
    const round = await createRoundWithCrashPoint(db, 500_000); // 50x, a long round
    await rounds.placeBet({
      userId,
      roundId: round.id,
      stakeMinor: STAKE,
      idempotencyKey: randomUUID(),
    });
    await launchRound(db, round.id);

    // The engine dies here, and comes back ten minutes later.
    await setElapsed(db, round.id, 10 * 60 * 1000);
    await engine(app).tick();

    const after = await rounds.getRound(round.id);
    expect(after.status).toBe('VOIDED');

    const bet = (await rounds.getUserBetsForRound(userId, round.id))[0]!;
    expect(bet.status).toBe('VOIDED');
    expect(bet.payoutMinor).toBe(STAKE);

    // Whole and entire: the player is exactly where they started.
    expect(await ledger.getUserBalance(userId)).toBe(GRANT);
    expect(await ledger.getBalance(SYSTEM_ACCOUNTS.ESCROW)).toBe(0);
    // The house neither won nor lost — no outcome was used.
    expect(await ledger.getBalance(SYSTEM_ACCOUNTS.HOUSE)).toBe(0);

    await expectLedgerIntact();
  });

  it('reveals the seed on a void, so voids can be audited against what they discarded', async () => {
    const round = await createRoundWithCrashPoint(db, 500_000);
    await launchRound(db, round.id);
    await setElapsed(db, round.id, 10 * 60 * 1000);

    await engine(app).tick();

    const after = await rounds.getRound(round.id);
    expect(after.status).toBe('VOIDED');
    expect(after.seedRevealed).toBe(round.seed);
    expect(after.crashPointBp).toBeNull(); // discarded, so not presented as an outcome
  });

  it('still crashes normally when it is only a little late', async () => {
    const userId = await makeUser();
    const round = await createRoundWithCrashPoint(db, 20_000);
    await rounds.placeBet({
      userId,
      roundId: round.id,
      stakeMinor: STAKE,
      idempotencyKey: randomUUID(),
    });
    await launchRound(db, round.id);

    // Just past the crash point but inside the grace window: a busy engine, not
    // an absent one. This must resolve as a normal loss, not a refund.
    await advanceToCrash(db, round.id, round.crashPointBp);
    await engine(app).tick();
    await engine(app).tick();

    const after = await rounds.getRound(round.id);
    expect(after.status).toBe('SETTLED');

    const bet = (await rounds.getUserBetsForRound(userId, round.id))[0]!;
    expect(bet.status).toBe('LOST');
    expect(await ledger.getUserBalance(userId)).toBe(GRANT - STAKE);

    await expectLedgerIntact();
  });

  it('leaves an already cashed-out bet alone when the round is voided', async () => {
    const cashedOut = await makeUser();
    const stillIn = await makeUser();
    const round = await createRoundWithCrashPoint(db, 500_000);

    const winnerBet = await rounds.placeBet({
      userId: cashedOut,
      roundId: round.id,
      stakeMinor: STAKE,
      idempotencyKey: randomUUID(),
    });
    await rounds.placeBet({
      userId: stillIn,
      roundId: round.id,
      stakeMinor: STAKE,
      idempotencyKey: randomUUID(),
    });

    await launchRound(db, round.id);
    await setElapsed(db, round.id, 5_000);
    const settled = await rounds.cashOut({ userId: cashedOut, betId: winnerBet.id });

    // Now the engine disappears.
    await setElapsed(db, round.id, 10 * 60 * 1000);
    await engine(app).tick();

    // The player who got out keeps their winnings; voiding does not claw back.
    expect(await ledger.getUserBalance(cashedOut)).toBe(GRANT - STAKE + settled.payoutMinor!);
    // The player still in gets their stake back.
    expect(await ledger.getUserBalance(stillIn)).toBe(GRANT);
    expect(await ledger.getBalance(SYSTEM_ACCOUNTS.ESCROW)).toBe(0);

    await expectLedgerIntact();
  });

  it('is idempotent — voiding twice refunds once', async () => {
    const userId = await makeUser();
    const round = await createRoundWithCrashPoint(db, 500_000);
    await rounds.placeBet({
      userId,
      roundId: round.id,
      stakeMinor: STAKE,
      idempotencyKey: randomUUID(),
    });
    await launchRound(db, round.id);
    await setElapsed(db, round.id, 10 * 60 * 1000);

    await engine(app).voidRound(round.id, 'test');
    await engine(app).voidRound(round.id, 'test again');

    expect(await ledger.getUserBalance(userId)).toBe(GRANT);

    const refunds = await db
      .selectFrom('transactions')
      .select(['id'])
      .where('kind', '=', 'ROUND_VOID_REFUND')
      .execute();
    expect(refunds).toHaveLength(1);

    await expectLedgerIntact();
  });

  it('opens a fresh round once a voided one is out of the way', async () => {
    const round = await createRoundWithCrashPoint(db, 500_000);
    await launchRound(db, round.id);
    await setElapsed(db, round.id, 10 * 60 * 1000);

    await engine(app).tick(); // voids it
    const next = await engine(app).openRoundIfDue();

    expect(next).not.toBeNull();
    expect(next).not.toBe(round.id);
  });
});
