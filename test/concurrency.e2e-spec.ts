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

/**
 * The acceptance criteria from PRD 5.2, as regression tests.
 *
 * These fire genuinely simultaneous transactions against real Postgres — no
 * mocks, no simulated clock — so the row locks, the unique indexes and the
 * conditional updates are all doing the work they claim to. The k6 scripts in
 * `loadtest/` run the same scenarios over HTTP at higher volume for the numbers
 * quoted in the README; these keep the guarantees from silently regressing.
 *
 * Every case ends by asserting the ledger still balances. "No over-spends" is a
 * far weaker claim without "and the books reconcile afterwards" — an
 * implementation could refuse the right number of requests and still corrupt
 * the ledger doing it.
 */
describe('Concurrency guarantees', () => {
  let app: INestApplication;
  let db: Kysely<DB>;
  let rounds: RoundsService;
  let ledger: LedgerService;
  let auth: AuthService;

  const GRANT = 100_000; // 1000.00

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

  describe('bet placement against one account', () => {
    it('lets exactly the affordable number of concurrent bets succeed', async () => {
      const userId = await makeUser();
      const round = await createRoundWithCrashPoint(db, 20_000);

      const STAKE = 10_000; // 100.00
      const ATTEMPTS = 40;
      const AFFORDABLE = GRANT / STAKE; // exactly 10

      // Fired together, each with its own idempotency key, so nothing but the
      // balance check can be deciding the outcome.
      const results = await Promise.allSettled(
        Array.from({ length: ATTEMPTS }, () =>
          rounds.placeBet({
            userId,
            roundId: round.id,
            stakeMinor: STAKE,
            idempotencyKey: randomUUID(),
          }),
        ),
      );

      const succeeded = results.filter((r) => r.status === 'fulfilled').length;
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(succeeded).toBe(AFFORDABLE);
      expect(rejected).toHaveLength(ATTEMPTS - AFFORDABLE);

      // Every refusal must be the *application* declining cleanly, never the
      // database catching an overdraft that got that far.
      //
      // This is what the row lock buys, and the distinction is the whole reason
      // it is there. Remove the `FOR UPDATE` and the balance stays correct —
      // the non-negative trigger sees to that — but most of these failures
      // become constraint violations, which reach a client as a 500 rather than
      // a 409. Measured on this machine at 40 concurrent: 28 of 30 refusals
      // arrive as constraint violations without the lock, and 0 with it.
      for (const failure of rejected) {
        const reason = failure.reason as { constructor: { name: string }; message: string };
        expect(reason.constructor.name).toBe('InsufficientFundsError');
        expect(reason.message).not.toMatch(/negative balance|check constraint/i);
      }

      // Zero over-spend: the wallet is empty, never negative.
      expect(await ledger.getUserBalance(userId)).toBe(0);
      expect(await ledger.getBalance(SYSTEM_ACCOUNTS.ESCROW)).toBe(GRANT);

      // Zero lost updates: exactly as many bets exist as succeeded.
      const bets = await rounds.getUserBetsForRound(userId, round.id);
      expect(bets).toHaveLength(AFFORDABLE);

      await expectLedgerIntact();
    });

    it('creates exactly one bet when the same idempotency key arrives many times at once', async () => {
      const userId = await makeUser();
      const round = await createRoundWithCrashPoint(db, 20_000);
      const sharedKey = randomUUID();

      const results = await Promise.allSettled(
        Array.from({ length: 25 }, () =>
          rounds.placeBet({
            userId,
            roundId: round.id,
            stakeMinor: 1_000,
            idempotencyKey: sharedKey,
          }),
        ),
      );

      const fulfilled = results.filter(
        (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof rounds.placeBet>>> =>
          r.status === 'fulfilled',
      );

      // Every caller gets an answer, and it is the same bet every time.
      expect(fulfilled).toHaveLength(25);
      const ids = new Set(fulfilled.map((r) => r.value.id));
      expect(ids.size).toBe(1);

      const bets = await rounds.getUserBetsForRound(userId, round.id);
      expect(bets).toHaveLength(1);
      // Debited exactly once, not 25 times.
      expect(await ledger.getUserBalance(userId)).toBe(GRANT - 1_000);

      await expectLedgerIntact();
    });

    it('keeps balances correct with many users betting on one round at once', async () => {
      const round = await createRoundWithCrashPoint(db, 20_000);
      const userIds = await Promise.all(Array.from({ length: 20 }, () => makeUser()));

      await Promise.all(
        userIds.map((userId) =>
          rounds.placeBet({
            userId,
            roundId: round.id,
            stakeMinor: 2_500,
            idempotencyKey: randomUUID(),
          }),
        ),
      );

      for (const userId of userIds) {
        expect(await ledger.getUserBalance(userId)).toBe(GRANT - 2_500);
      }
      expect(await ledger.getBalance(SYSTEM_ACCOUNTS.ESCROW)).toBe(20 * 2_500);

      await expectLedgerIntact();
    });
  });

  describe('cash-out', () => {
    it('pays out exactly once under a storm of simultaneous requests', async () => {
      const userId = await makeUser();
      const round = await createRoundWithCrashPoint(db, 50_000);
      const bet = await rounds.placeBet({
        userId,
        roundId: round.id,
        stakeMinor: 10_000,
        idempotencyKey: randomUUID(),
      });

      await launchRound(db, round.id);
      await setElapsed(db, round.id, 5_000);

      const results = await Promise.allSettled(
        Array.from({ length: 30 }, () => rounds.cashOut({ userId, betId: bet.id })),
      );

      const fulfilled = results.filter(
        (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof rounds.cashOut>>> =>
          r.status === 'fulfilled',
      );

      // Cash-out is idempotent, so every caller may legitimately succeed — but
      // they must all describe the *same* settlement.
      const payouts = new Set(fulfilled.map((r) => r.value.payoutMinor));
      const multipliers = new Set(fulfilled.map((r) => r.value.cashoutMultiplierBp));
      expect(payouts.size).toBe(1);
      expect(multipliers.size).toBe(1);

      const payout = [...payouts][0]!;

      // Paid once, not thirty times — this is the assertion that matters.
      expect(await ledger.getUserBalance(userId)).toBe(GRANT - 10_000 + payout);

      const cashouts = await db
        .selectFrom('transactions')
        .selectAll()
        .where('kind', '=', 'BET_CASHOUT')
        .where('reference_id', '=', bet.id)
        .execute();
      expect(cashouts).toHaveLength(1);

      await expectLedgerIntact();
    });

    it('never both pays out and writes off a bet when cash-out races settlement', async () => {
      // Repeated because the interleaving is genuinely nondeterministic: a
      // single pass could miss the window by luck.
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await resetDatabase(db);

        const userId = await makeUser();
        const round = await createRoundWithCrashPoint(db, 20_000);
        const bet = await rounds.placeBet({
          userId,
          roundId: round.id,
          stakeMinor: 10_000,
          idempotencyKey: randomUUID(),
        });

        await launchRound(db, round.id);
        // One tick short of the crash: the cash-out is legal for this instant,
        // and the resolver is about to run.
        await setElapsed(db, round.id, 6_900);

        const [cashOutResult] = await Promise.allSettled([
          rounds.cashOut({ userId, betId: bet.id }),
          (async () => {
            await advanceToCrash(db, round.id, round.crashPointBp);
            await engine(app).tick();
            await engine(app).tick();
          })(),
        ]);

        const finalBet = (await rounds.getUserBetsForRound(userId, round.id))[0]!;
        const balance = await ledger.getUserBalance(userId);

        if (cashOutResult.status === 'fulfilled') {
          // Won the race: paid, and recorded as cashed out.
          expect(finalBet.status).toBe('CASHED_OUT');
          expect(balance).toBe(GRANT - 10_000 + finalBet.payoutMinor!);
        } else {
          // Lost the race: written off, and not paid a thing.
          expect(finalBet.status).toBe('LOST');
          expect(balance).toBe(GRANT - 10_000);
        }

        // Whichever way it fell, exactly one settlement was posted.
        const settlements = await db
          .selectFrom('transactions')
          .select(['id', 'kind'])
          .where('reference_id', '=', bet.id)
          .where('kind', 'in', ['BET_CASHOUT', 'BET_LOST'])
          .execute();
        expect(settlements).toHaveLength(1);

        await expectLedgerIntact();
      }
    });

    it('refuses every late cash-out in a burst arriving after the crash', async () => {
      const userId = await makeUser();
      const round = await createRoundWithCrashPoint(db, 20_000);
      const bet = await rounds.placeBet({
        userId,
        roundId: round.id,
        stakeMinor: 10_000,
        idempotencyKey: randomUUID(),
      });

      await launchRound(db, round.id);
      await advanceToCrash(db, round.id, round.crashPointBp);

      const results = await Promise.allSettled(
        Array.from({ length: 20 }, () => rounds.cashOut({ userId, betId: bet.id })),
      );

      expect(results.every((r) => r.status === 'rejected')).toBe(true);
      expect(await ledger.getUserBalance(userId)).toBe(GRANT - 10_000);

      await expectLedgerIntact();
    });
  });
});
