import type { INestApplication } from '@nestjs/common';
import fc from 'fast-check';
import type { Kysely } from 'kysely';
import { Money } from '../src/common/money';
import { SYSTEM_ACCOUNTS, type DB } from '../src/database/schema';
import { LedgerService } from '../src/ledger/ledger.service';
import { TransactionKind } from '../src/ledger/ledger.types';
import { createTestApp, resetDatabase } from './helpers/test-app';

/**
 * The reconstruction property from PRD section 8.
 *
 * Generates arbitrary sequences of legal ledger movements and asserts, after
 * every sequence, that the books balance and that no cached balance has drifted
 * from the sum of its postings. Property-based rather than example-based because
 * the interesting failures here are orderings nobody thought to write down.
 */
describe('Ledger invariants (property-based)', () => {
  let app: INestApplication;
  let db: Kysely<DB>;
  let ledger: LedgerService;

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    db = ctx.db;
    ledger = app.get(LedgerService);
  });

  afterAll(async () => {
    await app.close();
  });

  /** A movement between two system accounts, in minor units. */
  const movement = fc.record({
    amount: fc.integer({ min: 1, max: 1_000_000 }),
    direction: fc.constantFrom('mint-to-house', 'house-to-escrow', 'escrow-to-house'),
  });

  it('keeps the global posting sum at zero across arbitrary movement sequences', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(movement, { minLength: 1, maxLength: 25 }), async (movements) => {
        await resetDatabase(db);

        // HOUSE and ESCROW must be able to cover what they send, and ESCROW may
        // never go negative, so the sequence is applied against tracked balances
        // and impossible steps are skipped rather than generated away.
        let house = 0;
        let escrow = 0;

        for (const m of movements) {
          const amount = Money.fromMinor(m.amount);

          if (m.direction === 'mint-to-house') {
            await ledger.post({
              kind: TransactionKind.SIGNUP_GRANT,
              postings: [
                { accountId: SYSTEM_ACCOUNTS.MINT, amount: Money.negate(amount) },
                { accountId: SYSTEM_ACCOUNTS.HOUSE, amount },
              ],
            });
            house += m.amount;
          } else if (m.direction === 'house-to-escrow') {
            await ledger.post({
              kind: TransactionKind.BET_PLACED,
              postings: [
                { accountId: SYSTEM_ACCOUNTS.HOUSE, amount: Money.negate(amount) },
                { accountId: SYSTEM_ACCOUNTS.ESCROW, amount },
              ],
            });
            house -= m.amount;
            escrow += m.amount;
          } else {
            if (escrow < m.amount) continue; // would drive escrow negative
            await ledger.post({
              kind: TransactionKind.BET_LOST,
              postings: [
                { accountId: SYSTEM_ACCOUNTS.ESCROW, amount: Money.negate(amount) },
                { accountId: SYSTEM_ACCOUNTS.HOUSE, amount },
              ],
            });
            escrow -= m.amount;
            house += m.amount;
          }
        }

        expect(await ledger.getGlobalSum()).toBe(0);
        expect(await ledger.findBalanceDrift()).toEqual([]);

        // The independently-tracked expectations must match what the ledger says.
        expect(await ledger.getBalance(SYSTEM_ACCOUNTS.HOUSE)).toBe(house);
        expect(await ledger.getBalance(SYSTEM_ACCOUNTS.ESCROW)).toBe(escrow);
      }),
      { numRuns: 12 },
    );
  });

  it('reconstructs every cached balance from its postings alone', async () => {
    await resetDatabase(db);

    for (let i = 0; i < 20; i += 1) {
      const amount = Money.fromMinor((i + 1) * 137);
      await ledger.post({
        kind: TransactionKind.SIGNUP_GRANT,
        postings: [
          { accountId: SYSTEM_ACCOUNTS.MINT, amount: Money.negate(amount) },
          { accountId: SYSTEM_ACCOUNTS.HOUSE, amount },
        ],
      });
    }

    // Recompute every balance from the entries table and compare to the cache.
    const computed = await db
      .selectFrom('entries')
      .select(['account_id'])
      .select((eb) => eb.fn.sum<number>('amount').as('total'))
      .groupBy('account_id')
      .execute();

    for (const row of computed) {
      const cached = await ledger.getBalance(row.account_id);
      expect(cached).toBe(Number(row.total));
    }

    expect(await ledger.findBalanceDrift()).toEqual([]);
    expect(await ledger.getGlobalSum()).toBe(0);
  });
});
