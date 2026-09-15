import type { INestApplication } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { randomUUID } from 'node:crypto';
import { Money } from '../src/common/money';
import { SYSTEM_ACCOUNTS, type DB } from '../src/database/schema';
import { UnbalancedTransactionError } from '../src/ledger/ledger.errors';
import { LedgerService } from '../src/ledger/ledger.service';
import { TransactionKind } from '../src/ledger/ledger.types';
import { createTestApp, resetDatabase } from './helpers/test-app';

/**
 * These tests assert that the guarantees hold *in the database*, independently of
 * the application. Each one bypasses LedgerService entirely and writes raw SQL,
 * because the claim being tested is "this cannot happen", not "our service does
 * not do this". A guarantee that only holds while every caller behaves is not a
 * guarantee.
 */
describe('Ledger constraints (enforced by Postgres)', () => {
  let app: INestApplication;
  let db: Kysely<DB>;
  let ledger: LedgerService;

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

  describe('GUARANTEE 1 — transactions must balance', () => {
    it('rejects an unbalanced transaction at COMMIT, bypassing the service layer', async () => {
      const txId = randomUUID();

      await expect(
        db.transaction().execute(async (trx) => {
          await trx.insertInto('transactions').values({ id: txId, kind: 'TEST' }).execute();
          await trx
            .insertInto('entries')
            .values([
              { transaction_id: txId, account_id: SYSTEM_ACCOUNTS.MINT, amount: -500 },
              { transaction_id: txId, account_id: SYSTEM_ACCOUNTS.HOUSE, amount: 400 },
            ])
            .execute();
        }),
      ).rejects.toThrow(/unbalanced/i);

      // The failed transaction must have left nothing behind.
      const count = await db
        .selectFrom('entries')
        .select(sql<number>`count(*)`.as('n'))
        .executeTakeFirstOrThrow();
      expect(Number(count.n)).toBe(0);
    });

    it('rejects a single-leg transaction: double-entry needs two sides', async () => {
      const txId = randomUUID();

      await expect(
        db.transaction().execute(async (trx) => {
          await trx.insertInto('transactions').values({ id: txId, kind: 'TEST' }).execute();
          await trx
            .insertInto('entries')
            .values({ transaction_id: txId, account_id: SYSTEM_ACCOUNTS.MINT, amount: -500 })
            .execute();
        }),
      ).rejects.toThrow(/double-entry requires at least 2/i);
    });

    it('accepts a balanced transaction', async () => {
      const posted = await ledger.post({
        kind: TransactionKind.SIGNUP_GRANT,
        postings: [
          { accountId: SYSTEM_ACCOUNTS.MINT, amount: Money.fromMinor(-500) },
          { accountId: SYSTEM_ACCOUNTS.HOUSE, amount: Money.fromMinor(500) },
        ],
      });

      expect(posted.id).toBeDefined();
      expect(await ledger.getGlobalSum()).toBe(0);
    });

    it('refuses an unbalanced posting set in the service before reaching the database', async () => {
      await expect(
        ledger.post({
          kind: TransactionKind.SIGNUP_GRANT,
          postings: [
            { accountId: SYSTEM_ACCOUNTS.MINT, amount: Money.fromMinor(-500) },
            { accountId: SYSTEM_ACCOUNTS.HOUSE, amount: Money.fromMinor(499) },
          ],
        }),
      ).rejects.toBeInstanceOf(UnbalancedTransactionError);
    });
  });

  describe('GUARANTEE 2 — the ledger is append-only', () => {
    beforeEach(async () => {
      await ledger.post({
        kind: TransactionKind.SIGNUP_GRANT,
        postings: [
          { accountId: SYSTEM_ACCOUNTS.MINT, amount: Money.fromMinor(-500) },
          { accountId: SYSTEM_ACCOUNTS.HOUSE, amount: Money.fromMinor(500) },
        ],
      });
    });

    it('refuses UPDATE on entries', async () => {
      await expect(
        db.updateTable('entries').set({ amount: 999 }).where('amount', '=', 500).execute(),
      ).rejects.toThrow(/append-only/i);
    });

    it('refuses DELETE on entries', async () => {
      await expect(
        db.deleteFrom('entries').where('amount', '=', 500).execute(),
      ).rejects.toThrow(/append-only/i);
    });

    it('refuses UPDATE on transactions', async () => {
      await expect(
        db.updateTable('transactions').set({ kind: 'TAMPERED' }).execute(),
      ).rejects.toThrow(/append-only/i);
    });
  });

  describe('GUARANTEE 3 — wallets and escrow cannot go negative', () => {
    it('refuses a negative ESCROW balance', async () => {
      await expect(
        db
          .updateTable('balances')
          .set({ balance: -1 })
          .where('account_id', '=', SYSTEM_ACCOUNTS.ESCROW)
          .execute(),
      ).rejects.toThrow(/may not hold a negative balance/i);
    });

    it('permits a negative MINT balance, which is how credits are issued', async () => {
      await expect(
        db
          .updateTable('balances')
          .set({ balance: -100_000 })
          .where('account_id', '=', SYSTEM_ACCOUNTS.MINT)
          .execute(),
      ).resolves.toBeDefined();
    });

    it('permits a negative HOUSE balance, which is what being down looks like', async () => {
      await expect(
        db
          .updateTable('balances')
          .set({ balance: -5_000 })
          .where('account_id', '=', SYSTEM_ACCOUNTS.HOUSE)
          .execute(),
      ).resolves.toBeDefined();
    });
  });
});
