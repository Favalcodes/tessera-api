import type { INestApplication } from '@nestjs/common';
import { pocketColour, ROULETTE_ODDS_BP, type RouletteSelection } from '@tessera/contracts';
import type { Kysely } from 'kysely';
import { randomUUID } from 'node:crypto';
import { AuthService } from '../src/auth/auth.service';
import { SYSTEM_ACCOUNTS, type DB } from '../src/database/database.types';
import { LedgerService } from '../src/ledger/ledger.service';
import { RoundsService } from '../src/rounds/rounds.service';
import { createRouletteRound, engine, launchRound } from './helpers/round-fixtures';
import { createTestApp, resetDatabase, uniqueEmail } from './helpers/test-app';

const GRANT = 100_000;
const STAKE = 10_000; // 100.00

/**
 * European roulette.
 *
 * The interesting work here is the opposite of crash's. There is no timing and
 * no cash-out; instead many bet types at different odds are placed on one spin
 * and settled together against a single pocket.
 */
describe('Roulette', () => {
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

  /** Bet, spin, settle. */
  async function spin(roundId: string) {
    await launchRound(db, roundId);
    await engine(app).resolveRound(roundId);
    await engine(app).settleRound(roundId);
  }

  describe('settlement', () => {
    // One case per bet type, each against a pocket chosen to make it win.
    const winning: Array<{ selection: RouletteSelection; pocket: number; label: string }> = [
      { selection: { type: 'STRAIGHT', value: 17 }, pocket: 17, label: 'straight up' },
      { selection: { type: 'RED' }, pocket: 3, label: 'red' },
      { selection: { type: 'BLACK' }, pocket: 2, label: 'black' },
      { selection: { type: 'ODD' }, pocket: 5, label: 'odd' },
      { selection: { type: 'EVEN' }, pocket: 8, label: 'even' },
      { selection: { type: 'LOW' }, pocket: 1, label: 'low' },
      { selection: { type: 'HIGH' }, pocket: 36, label: 'high' },
      { selection: { type: 'DOZEN', value: 2 }, pocket: 13, label: '2nd dozen' },
      { selection: { type: 'COLUMN', value: 1 }, pocket: 4, label: 'column 1' },
    ];

    it.each(winning)('pays a winning $label at the published odds', async ({ selection, pocket }) => {
      const userId = await makeUser();
      const round = await createRouletteRound(db, pocket);

      await rounds.placeBet({
        userId,
        roundId: round.id,
        stakeMinor: STAKE,
        idempotencyKey: randomUUID(),
        selection,
      });

      await spin(round.id);

      const bet = (await rounds.getUserBetsForRound(userId, round.id))[0]!;
      const odds = ROULETTE_ODDS_BP[selection.type];

      expect(bet.status).toBe('WON');
      expect(bet.settledMultiplierBp).toBe(odds);
      expect(bet.payoutMinor).toBe((STAKE * odds) / 10_000);
      expect(await ledger.getUserBalance(userId)).toBe(GRANT - STAKE + (STAKE * odds) / 10_000);
      await expectLedgerIntact();
    });

    it('takes the stake when the selection does not come in', async () => {
      const userId = await makeUser();
      const round = await createRouletteRound(db, 17);

      await rounds.placeBet({
        userId,
        roundId: round.id,
        stakeMinor: STAKE,
        idempotencyKey: randomUUID(),
        selection: { type: 'STRAIGHT', value: 4 },
      });

      await spin(round.id);

      const bet = (await rounds.getUserBetsForRound(userId, round.id))[0]!;
      expect(bet.status).toBe('LOST');
      expect(await ledger.getUserBalance(userId)).toBe(GRANT - STAKE);
      expect(await ledger.getBalance(SYSTEM_ACCOUNTS.HOUSE)).toBe(STAKE);
      await expectLedgerIntact();
    });

    /**
     * Zero is the house edge, and the whole of it. Every outside bet loses on
     * it — not by special case, but because zero is in no colour, no parity, no
     * dozen and no column.
     */
    it.each([
      { type: 'RED' },
      { type: 'BLACK' },
      { type: 'ODD' },
      { type: 'EVEN' },
      { type: 'LOW' },
      { type: 'HIGH' },
      { type: 'DOZEN', value: 1 },
      { type: 'COLUMN', value: 1 },
    ] as RouletteSelection[])('loses a $type bet on zero', async (selection) => {
      const userId = await makeUser();
      const round = await createRouletteRound(db, 0);

      await rounds.placeBet({
        userId,
        roundId: round.id,
        stakeMinor: STAKE,
        idempotencyKey: randomUUID(),
        selection,
      });

      await spin(round.id);

      const bet = (await rounds.getUserBetsForRound(userId, round.id))[0]!;
      expect(bet.status).toBe('LOST');
      await expectLedgerIntact();
    });

    it('pays a straight-up bet on zero, which is the only bet that wins there', async () => {
      const userId = await makeUser();
      const round = await createRouletteRound(db, 0);

      await rounds.placeBet({
        userId,
        roundId: round.id,
        stakeMinor: STAKE,
        idempotencyKey: randomUUID(),
        selection: { type: 'STRAIGHT', value: 0 },
      });

      await spin(round.id);

      const bet = (await rounds.getUserBetsForRound(userId, round.id))[0]!;
      expect(bet.status).toBe('WON');
      expect(pocketColour(0)).toBe('green');
      await expectLedgerIntact();
    });

    it('settles many bets from one player on a single spin', async () => {
      const userId = await makeUser();
      const round = await createRouletteRound(db, 17); // black, odd, 2nd dozen, column 2

      const placed: RouletteSelection[] = [
        { type: 'STRAIGHT', value: 17 }, // wins 36x
        { type: 'BLACK' }, //               wins 2x
        { type: 'ODD' }, //                 wins 2x
        { type: 'RED' }, //                 loses
        { type: 'DOZEN', value: 1 }, //     loses
      ];

      for (const selection of placed) {
        await rounds.placeBet({
          userId,
          roundId: round.id,
          stakeMinor: 1_000,
          idempotencyKey: randomUUID(),
          selection,
        });
      }

      await spin(round.id);

      const bets = await rounds.getUserBetsForRound(userId, round.id);
      expect(bets).toHaveLength(5);
      expect(bets.filter((b) => b.status === 'WON')).toHaveLength(3);
      expect(bets.filter((b) => b.status === 'LOST')).toHaveLength(2);

      // 5 x 10.00 staked; back 36 + 2 + 2 = 40 units of 10.00.
      const expected = GRANT - 5 * 1_000 + 40 * 1_000;
      expect(await ledger.getUserBalance(userId)).toBe(expected);
      expect(await ledger.getBalance(SYSTEM_ACCOUNTS.ESCROW)).toBe(0);
      await expectLedgerIntact();
    });
  });

  describe('rules', () => {
    it('refuses a roulette bet with no selection', async () => {
      const userId = await makeUser();
      const round = await createRouletteRound(db, 7);

      await expect(
        rounds.placeBet({
          userId,
          roundId: round.id,
          stakeMinor: STAKE,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toThrow(/must name what it is backing/i);
    });

    it('refuses a selection on a crash round rather than ignoring it', async () => {
      const { createRoundWithCrashPoint } = await import('./helpers/round-fixtures');
      const userId = await makeUser();
      const round = await createRoundWithCrashPoint(db, 20_000);

      await expect(
        rounds.placeBet({
          userId,
          roundId: round.id,
          stakeMinor: STAKE,
          idempotencyKey: randomUUID(),
          selection: { type: 'RED' },
        }),
      ).rejects.toThrow(/do not take a selection/i);
    });

    it('refuses a pocket that is not on the wheel', async () => {
      const userId = await makeUser();
      const round = await createRouletteRound(db, 7);

      await expect(
        rounds.placeBet({
          userId,
          roundId: round.id,
          stakeMinor: STAKE,
          idempotencyKey: randomUUID(),
          selection: { type: 'STRAIGHT', value: 37 },
        }),
      ).rejects.toThrow(/0 to 36/i);
    });

    it('refuses to cash out of roulette, which has no such action', async () => {
      const userId = await makeUser();
      const round = await createRouletteRound(db, 7);
      const bet = await rounds.placeBet({
        userId,
        roundId: round.id,
        stakeMinor: STAKE,
        idempotencyKey: randomUUID(),
        selection: { type: 'RED' },
      });

      await launchRound(db, round.id);

      await expect(rounds.cashOut({ userId, betId: bet.id })).rejects.toThrow(
        /nothing to cash out/i,
      );
      await expectLedgerIntact();
    });

    it('pays at the odds stored on the bet, not at the table today', async () => {
      const userId = await makeUser();
      const round = await createRouletteRound(db, 3);

      const bet = await rounds.placeBet({
        userId,
        roundId: round.id,
        stakeMinor: STAKE,
        idempotencyKey: randomUUID(),
        selection: { type: 'RED' },
      });

      // Someone edits the odds table between placement and settlement.
      await db.updateTable('bets').set({ odds_bp: 50_000 }).where('id', '=', bet.id).execute();

      await spin(round.id);

      const settled = (await rounds.getUserBetsForRound(userId, round.id))[0]!;
      expect(settled.settledMultiplierBp).toBe(50_000);
      expect(settled.payoutMinor).toBe((STAKE * 50_000) / 10_000);
      await expectLedgerIntact();
    });
  });

  describe('running alongside crash', () => {
    it('keeps a live round of each game at once', async () => {
      const crashId = await engine(app).openRoundIfDue('CRASH');
      const rouletteId = await engine(app).openRoundIfDue('ROULETTE');

      expect(crashId).not.toBeNull();
      expect(rouletteId).not.toBeNull();
      expect(crashId).not.toBe(rouletteId);

      const live = await db
        .selectFrom('rounds')
        .select(['game', 'status'])
        .where('status', 'in', ['OPEN', 'LOCKED', 'RUNNING'])
        .execute();

      expect(live).toHaveLength(2);
      expect(new Set(live.map((r) => r.game))).toEqual(new Set(['CRASH', 'ROULETTE']));
    });

    it('will not open a second live round of the same game', async () => {
      await engine(app).openRoundIfDue('ROULETTE');
      const duplicate = await engine(app).openRoundIfDue('ROULETTE');
      expect(duplicate).toBeNull();
    });

    it('draws both games from the same committed chain', async () => {
      await engine(app).openRoundIfDue('CRASH');
      await engine(app).openRoundIfDue('ROULETTE');

      const rows = await db
        .selectFrom('rounds')
        .select(['game', 'chain_id', 'chain_index'])
        .orderBy('nonce', 'asc')
        .execute();

      expect(rows).toHaveLength(2);
      expect(rows[0]!.chain_id).toBe(rows[1]!.chain_id);
      expect(rows[0]!.chain_index).not.toBe(rows[1]!.chain_index);
    });
  });
});
