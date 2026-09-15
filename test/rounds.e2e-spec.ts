import type { INestApplication } from '@nestjs/common';
import { BASIS_POINTS_ONE, multiplierAtElapsed } from '@tessera/contracts';
import type { Kysely } from 'kysely';
import { randomUUID } from 'node:crypto';
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

const GRANT = 100_000; // 1000.00

describe('Rounds: lifecycle, betting and cash-out', () => {
  let app: INestApplication;
  let db: Kysely<DB>;
  let rounds: RoundsService;
  let ledger: LedgerService;

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    db = ctx.db;
    rounds = app.get(RoundsService);
    ledger = app.get(LedgerService);
  });

  beforeEach(async () => {
    await resetDatabase(db);
  });

  afterAll(async () => {
    await app.close();
  });

  async function makeUser() {
    const { AuthService } = await import('../src/auth/auth.service');
    const auth = app.get(AuthService);
    const result = await auth.register({
      email: uniqueEmail(),
      displayName: 'Ada',
      password: 'correct-horse-battery-staple',
    });
    return result.user.id;
  }

  /** Every test ends here: the books must still balance. */
  async function expectLedgerIntact() {
    expect(await ledger.getGlobalSum()).toBe(0);
    expect(await ledger.findBalanceDrift()).toEqual([]);
  }

  describe('lifecycle', () => {
    it('drives a round OPEN -> LOCKED -> FLYING -> CRASHED -> SETTLED', async () => {
      const round = await createRoundWithCrashPoint(db, 20_000, { bettingWindowMs: -1 });

      await engine(app).tick(); // window elapsed -> LOCKED
      expect((await rounds.getRound(round.id)).status).toBe('LOCKED');

      await engine(app).tick(); // -> FLYING
      expect((await rounds.getRound(round.id)).status).toBe('FLYING');

      await advanceToCrash(db, round.id, round.crashPointBp);
      await engine(app).tick(); // -> CRASHED
      expect((await rounds.getRound(round.id)).status).toBe('CRASHED');

      await engine(app).tick(); // -> SETTLED
      expect((await rounds.getRound(round.id)).status).toBe('SETTLED');
    });

    it('withholds the crash point and the seed until the round has crashed', async () => {
      const round = await createRoundWithCrashPoint(db, 25_000);

      const open = await rounds.getRound(round.id);
      expect(open.crashPointBp).toBeNull();
      expect(open.seedRevealed).toBeNull();
      expect(open.seedHash).toHaveLength(64);

      await launchRound(db, round.id);
      const flying = await rounds.getRound(round.id);
      expect(flying.crashPointBp).toBeNull();
      expect(flying.seedRevealed).toBeNull();

      await advanceToCrash(db, round.id, round.crashPointBp);
      await engine(app).tick();

      const crashed = await rounds.getRound(round.id);
      expect(crashed.crashPointBp).toBe(25_000);
      expect(crashed.seedRevealed).toBe(round.seed);
    });

    it('refuses to open a second live round', async () => {
      await createRoundWithCrashPoint(db, 20_000);
      const second = await engine(app).openRoundIfDue();
      expect(second).toBeNull();
    });
  });

  describe('placing a bet', () => {
    it('debits the stake into escrow, leaving the books balanced', async () => {
      const userId = await makeUser();
      const round = await createRoundWithCrashPoint(db, 20_000);

      const bet = await rounds.placeBet({
        userId,
        roundId: round.id,
        stakeMinor: 5_000,
        idempotencyKey: randomUUID(),
      });

      expect(bet.status).toBe('ACTIVE');
      expect(bet.stake).toBe('50.00');
      expect(await ledger.getUserBalance(userId)).toBe(GRANT - 5_000);
      expect(await ledger.getBalance(SYSTEM_ACCOUNTS.ESCROW)).toBe(5_000);
      await expectLedgerIntact();
    });

    it('returns the original bet when a request is replayed', async () => {
      const userId = await makeUser();
      const round = await createRoundWithCrashPoint(db, 20_000);
      const key = randomUUID();

      const first = await rounds.placeBet({
        userId,
        roundId: round.id,
        stakeMinor: 5_000,
        idempotencyKey: key,
      });
      const replay = await rounds.placeBet({
        userId,
        roundId: round.id,
        stakeMinor: 5_000,
        idempotencyKey: key,
      });

      expect(replay.id).toBe(first.id);
      // A replay must not debit a second time.
      expect(await ledger.getUserBalance(userId)).toBe(GRANT - 5_000);
      await expectLedgerIntact();
    });

    it('rejects a stake the balance cannot cover', async () => {
      const userId = await makeUser();
      const round = await createRoundWithCrashPoint(db, 20_000);

      await expect(
        rounds.placeBet({
          userId,
          roundId: round.id,
          stakeMinor: GRANT + 1,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toThrow(/insufficient/i);

      expect(await ledger.getUserBalance(userId)).toBe(GRANT);
      await expectLedgerIntact();
    });

    it('rejects a bet once betting has closed', async () => {
      const userId = await makeUser();
      const round = await createRoundWithCrashPoint(db, 20_000);
      await launchRound(db, round.id);

      await expect(
        rounds.placeBet({
          userId,
          roundId: round.id,
          stakeMinor: 1_000,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toThrow(/betting is closed/i);
    });

    it('rejects a stake outside the configured bounds', async () => {
      const userId = await makeUser();
      const round = await createRoundWithCrashPoint(db, 20_000);

      await expect(
        rounds.placeBet({ userId, roundId: round.id, stakeMinor: 1, idempotencyKey: randomUUID() }),
      ).rejects.toThrow(/stake must be between/i);
    });
  });

  describe('cashing out', () => {
    it('pays stake times the multiplier, funded by escrow and the house', async () => {
      const userId = await makeUser();
      const round = await createRoundWithCrashPoint(db, 50_000); // crashes at 5.00x
      const placed = await rounds.placeBet({
        userId,
        roundId: round.id,
        stakeMinor: 10_000,
        idempotencyKey: randomUUID(),
      });
      await launchRound(db, round.id);

      // 7 seconds in, the curve reads 2.01x.
      await setElapsed(db, round.id, 7_000);
      const expectedBp = multiplierAtElapsed(7_000);

      const bet = await rounds.cashOut({ userId, betId: placed.id });

      expect(bet.status).toBe('CASHED_OUT');
      expect(bet.cashoutMultiplierBp).toBe(expectedBp);

      const expectedPayout = Math.floor((10_000 * expectedBp) / BASIS_POINTS_ONE);
      expect(bet.payoutMinor).toBe(expectedPayout);
      expect(await ledger.getUserBalance(userId)).toBe(GRANT - 10_000 + expectedPayout);
      // Escrow is emptied by the payout; the house funded the profit.
      expect(await ledger.getBalance(SYSTEM_ACCOUNTS.ESCROW)).toBe(0);
      expect(await ledger.getBalance(SYSTEM_ACCOUNTS.HOUSE)).toBe(-(expectedPayout - 10_000));
      await expectLedgerIntact();
    });

    it('is idempotent — cashing out twice returns the first result and pays once', async () => {
      const userId = await makeUser();
      const round = await createRoundWithCrashPoint(db, 50_000);
      const placed = await rounds.placeBet({
        userId,
        roundId: round.id,
        stakeMinor: 10_000,
        idempotencyKey: randomUUID(),
      });
      await launchRound(db, round.id);
      await setElapsed(db, round.id, 5_000);

      const first = await rounds.cashOut({ userId, betId: placed.id });
      const balanceAfterFirst = await ledger.getUserBalance(userId);

      const second = await rounds.cashOut({ userId, betId: placed.id });

      expect(second.id).toBe(first.id);
      expect(second.payoutMinor).toBe(first.payoutMinor);
      expect(await ledger.getUserBalance(userId)).toBe(balanceAfterFirst);
      await expectLedgerIntact();
    });

    it('refuses a cash-out at or past the crash point, even while status says FLYING', async () => {
      const userId = await makeUser();
      const round = await createRoundWithCrashPoint(db, 20_000); // 2.00x
      const placed = await rounds.placeBet({
        userId,
        roundId: round.id,
        stakeMinor: 10_000,
        idempotencyKey: randomUUID(),
      });
      await launchRound(db, round.id);

      // Past the crash point, but the engine has not ticked — the row still
      // says FLYING. Trusting status here would pay for a multiplier that
      // never existed.
      await advanceToCrash(db, round.id, round.crashPointBp);
      expect((await rounds.getRound(round.id)).status).toBe('FLYING');

      await expect(rounds.cashOut({ userId, betId: placed.id })).rejects.toThrow(/too late/i);

      expect(await ledger.getUserBalance(userId)).toBe(GRANT - 10_000);
      await expectLedgerIntact();
    });

    it('pays out at the very last tick before the crash', async () => {
      const userId = await makeUser();
      const round = await createRoundWithCrashPoint(db, 20_000);
      const placed = await rounds.placeBet({
        userId,
        roundId: round.id,
        stakeMinor: 10_000,
        idempotencyKey: randomUUID(),
      });
      await launchRound(db, round.id);

      const { elapsedAtMultiplier, TICK_MS } = await import('@tessera/contracts');
      await setElapsed(db, round.id, elapsedAtMultiplier(round.crashPointBp) - TICK_MS);

      const bet = await rounds.cashOut({ userId, betId: placed.id });
      expect(bet.status).toBe('CASHED_OUT');
      expect(bet.cashoutMultiplierBp).toBeLessThan(round.crashPointBp);
      await expectLedgerIntact();
    });

    it('refuses a cash-out against a bet the user does not own', async () => {
      const userId = await makeUser();
      const other = await makeUser();
      const round = await createRoundWithCrashPoint(db, 20_000);
      const theirBet = await rounds.placeBet({
        userId: other,
        roundId: round.id,
        stakeMinor: 1_000,
        idempotencyKey: randomUUID(),
      });
      await launchRound(db, round.id);

      // Scoped by user id as well as bet id, so one player cannot cash out
      // another's bet by guessing its identifier.
      await expect(rounds.cashOut({ userId, betId: theirBet.id })).rejects.toThrow(
        /no active bet/i,
      );
    });
  });

  describe('settlement', () => {
    it('moves a lost stake from escrow to the house and empties escrow', async () => {
      const userId = await makeUser();
      const round = await createRoundWithCrashPoint(db, 20_000);
      await rounds.placeBet({
        userId,
        roundId: round.id,
        stakeMinor: 10_000,
        idempotencyKey: randomUUID(),
      });
      await launchRound(db, round.id);
      await advanceToCrash(db, round.id, round.crashPointBp);

      await engine(app).tick(); // CRASHED
      await engine(app).tick(); // SETTLED

      const [bet] = await rounds.getUserBetsForRound(userId, round.id);
      expect(bet?.status).toBe('LOST');
      expect(await ledger.getUserBalance(userId)).toBe(GRANT - 10_000);
      expect(await ledger.getBalance(SYSTEM_ACCOUNTS.ESCROW)).toBe(0);
      expect(await ledger.getBalance(SYSTEM_ACCOUNTS.HOUSE)).toBe(10_000);
      await expectLedgerIntact();
    });

    it('leaves escrow empty once a round with both a winner and a loser settles', async () => {
      const winner = await makeUser();
      const loser = await makeUser();
      const round = await createRoundWithCrashPoint(db, 50_000);

      const winnerBet = await rounds.placeBet({
        userId: winner,
        roundId: round.id,
        stakeMinor: 10_000,
        idempotencyKey: randomUUID(),
      });
      await rounds.placeBet({
        userId: loser,
        roundId: round.id,
        stakeMinor: 4_000,
        idempotencyKey: randomUUID(),
      });

      await launchRound(db, round.id);
      await setElapsed(db, round.id, 5_000);
      await rounds.cashOut({ userId: winner, betId: winnerBet.id });

      await advanceToCrash(db, round.id, round.crashPointBp);
      await engine(app).tick();
      await engine(app).tick();

      // ESCROW holding zero outside a live round is the invariant from ADR-005.
      expect(await ledger.getBalance(SYSTEM_ACCOUNTS.ESCROW)).toBe(0);
      expect(await ledger.getUserBalance(loser)).toBe(GRANT - 4_000);
      await expectLedgerIntact();
    });
  });
});
