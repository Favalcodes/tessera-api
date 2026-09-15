import { Injectable, Logger } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { Money } from '../common/value-objects/money';
import { DatabaseService } from '../database/database.service';
import { SYSTEM_ACCOUNTS, walletKey, type DB } from '../database/database.types';
import { AccountNotFoundError, InsufficientFundsError, UnbalancedTransactionError } from './exceptions/ledger.exceptions';
import type { Executor, LedgerEntryView, PostInput, PostedTransaction } from './ledger.types';

/**
 * The ledger (ADR-005).
 *
 * This class is the *only* code in the system permitted to write to
 * `transactions`, `entries` or `balances`. A lint rule in eslint.config.mjs
 * makes writing them from anywhere else a build failure, and the database
 * enforces the invariants independently in case both are ever circumvented.
 *
 * Nothing here mutates a balance directly. A balance is a consequence of
 * postings, and `balances` is a cache of that consequence maintained inside the
 * same database transaction as the postings themselves — never eventually, so it
 * can never be observed stale.
 */
@Injectable()
export class LedgerService {
  private readonly logger = new Logger(LedgerService.name);

  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /**
   * Post a balanced transaction.
   *
   * Pass `executor` to enlist in a caller's open transaction — essential for bet
   * placement, where the balance check, the postings and the bet row must commit
   * or roll back as one unit. Without it, a new transaction is opened.
   */
  async post(input: PostInput, executor?: Executor): Promise<PostedTransaction> {
    this.assertBalanced(input);

    if (executor && 'isTransaction' in executor) {
      return this.postInTransaction(input, executor as Transaction<DB>);
    }

    return this.db.transaction().execute((trx) => this.postInTransaction(input, trx));
  }

  private assertBalanced(input: PostInput): void {
    if (input.postings.length < 2) {
      throw new UnbalancedTransactionError(0);
    }

    const sum = input.postings.reduce((acc, p) => acc + p.amount, 0);
    if (sum !== 0) {
      throw new UnbalancedTransactionError(sum);
    }

    if (input.postings.some((p) => p.amount === 0)) {
      throw new UnbalancedTransactionError(0);
    }
  }

  private async postInTransaction(
    input: PostInput,
    trx: Transaction<DB>,
  ): Promise<PostedTransaction> {
    const transaction = await trx
      .insertInto('transactions')
      .values({
        kind: input.kind,
        reference_type: input.reference?.type ?? null,
        reference_id: input.reference?.id ?? null,
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();

    await trx
      .insertInto('entries')
      .values(
        input.postings.map((p) => ({
          transaction_id: transaction.id,
          account_id: p.accountId,
          amount: p.amount,
        })),
      )
      .execute();

    // Apply balance deltas in a deterministic account order.
    //
    // Two concurrent transactions touching the same pair of accounts in opposite
    // orders will deadlock, and a bet (wallet -> escrow) and a payout
    // (escrow -> wallet) are exactly that pair. Sorting by account id means every
    // transaction in the system takes its row locks in the same sequence, so the
    // cycle cannot form. This is cheap here and very unpleasant to diagnose in
    // production.
    const ordered = [...input.postings].sort((a, b) => a.accountId.localeCompare(b.accountId));

    for (const posting of ordered) {
      const result = await trx
        .updateTable('balances')
        .set({
          balance: sql<number>`balances.balance + ${posting.amount}`,
          updated_at: sql<Date>`now()`,
        })
        .where('account_id', '=', posting.accountId)
        .executeTakeFirst();

      // Every account is given a balances row by trigger at creation, so a miss
      // here means the account does not exist. Fail rather than silently posting
      // an entry whose balance nothing is tracking.
      if (result.numUpdatedRows !== 1n) {
        throw new AccountNotFoundError(posting.accountId);
      }
    }

    this.logger.debug(
      `posted ${input.kind} tx=${transaction.id} legs=${input.postings.length}`,
    );

    return { id: transaction.id, kind: input.kind, postings: input.postings };
  }

  /**
   * Lock an account row and return its balance.
   *
   * `FOR UPDATE` on the balances row is what makes check-then-debit atomic: a
   * second concurrent request blocks here until the first commits, and then sees
   * the post-debit balance rather than the stale one it would otherwise have
   * read. This is the mechanism behind the zero-over-spend claim, and it only
   * works if the caller is already inside a transaction — hence the required
   * `trx` argument.
   */
  async lockBalanceForUpdate(trx: Transaction<DB>, accountId: string): Promise<Money> {
    const row = await trx
      .selectFrom('balances')
      .select(['balance'])
      .where('account_id', '=', accountId)
      .forUpdate()
      .executeTakeFirst();

    if (!row) {
      // No balances row yet means no postings yet, which is a zero balance. Take
      // the account lock instead so the row cannot be created underneath us.
      const account = await trx
        .selectFrom('accounts')
        .select(['id'])
        .where('id', '=', accountId)
        .forUpdate()
        .executeTakeFirst();

      if (!account) throw new AccountNotFoundError(accountId);
      return Money.zero;
    }

    return Money.fromMinor(row.balance);
  }

  /**
   * Lock a wallet and assert it can cover `amount`.
   *
   * The database will refuse a negative wallet balance regardless (GUARANTEE 3 in
   * the initial migration); this exists so callers get a typed, catchable error
   * instead of a constraint violation, and so the failure is attributable to a
   * specific account and amount.
   */
  async lockAndAssertSufficient(
    trx: Transaction<DB>,
    accountId: string,
    amount: Money,
  ): Promise<Money> {
    const balance = await this.lockBalanceForUpdate(trx, accountId);

    if (balance < amount) {
      throw new InsufficientFundsError(balance, amount);
    }

    return balance;
  }

  async getWalletAccountId(userId: string, executor: Executor = this.db): Promise<string> {
    const row = await executor
      .selectFrom('accounts')
      .select(['id'])
      .where('key', '=', walletKey(userId))
      .executeTakeFirst();

    if (!row) throw new AccountNotFoundError(walletKey(userId));
    return row.id;
  }

  /**
   * Create a user's wallet account. Called once, during registration.
   * The balances row is created by trigger, so there is no way to end up with a
   * wallet that has no balance to track.
   */
  async createWallet(userId: string, trx: Transaction<DB>): Promise<string> {
    const account = await trx
      .insertInto('accounts')
      .values({ kind: 'WALLET', owner_user_id: userId, key: walletKey(userId) })
      .returning(['id'])
      .executeTakeFirstOrThrow();

    return account.id;
  }

  async getBalance(accountId: string, executor: Executor = this.db): Promise<Money> {
    const row = await executor
      .selectFrom('balances')
      .select(['balance'])
      .where('account_id', '=', accountId)
      .executeTakeFirst();

    return Money.fromMinor(row?.balance ?? 0);
  }

  async getUserBalance(userId: string, executor: Executor = this.db): Promise<Money> {
    const accountId = await this.getWalletAccountId(userId, executor);
    return this.getBalance(accountId, executor);
  }

  /**
   * Paginated posting history for an account, newest first.
   *
   * Keyset pagination on the monotonic `entries.id` rather than OFFSET: the
   * ledger only ever grows, so an offset-based page would shift under a reader
   * and silently skip rows.
   */
  async getHistory(
    accountId: string,
    options: { limit: number; cursor?: number; referenceType?: string } = { limit: 50 },
  ): Promise<{ entries: LedgerEntryView[]; nextCursor: number | null }> {
    const limit = Math.min(Math.max(options.limit, 1), 200);

    let query = this.db
      .selectFrom('entries as e')
      .innerJoin('transactions as t', 't.id', 'e.transaction_id')
      .select([
        'e.id as id',
        'e.transaction_id as transaction_id',
        'e.amount as amount',
        'e.created_at as created_at',
        't.kind as kind',
        't.reference_type as reference_type',
        't.reference_id as reference_id',
      ])
      .where('e.account_id', '=', accountId)
      .orderBy('e.id', 'desc')
      .limit(limit + 1);

    if (options.cursor !== undefined) {
      query = query.where('e.id', '<', options.cursor);
    }
    if (options.referenceType) {
      query = query.where('t.reference_type', '=', options.referenceType);
    }

    const rows = await query.execute();
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    return {
      entries: page.map((r) => ({
        id: r.id,
        transactionId: r.transaction_id,
        transactionKind: r.kind,
        amount: Money.fromMinor(r.amount),
        balanceAfter: null,
        referenceType: r.reference_type,
        referenceId: r.reference_id,
        createdAt: r.created_at,
      })),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  /**
   * The system-wide invariant: every posting ever written sums to zero.
   *
   * One query over the whole ledger. Cheap enough to assert at the end of every
   * load test, which is what makes the concurrency results meaningful — "500
   * concurrent bets, no over-spends" is a much weaker claim without "and the
   * books still balance to the cent afterwards".
   */
  async getGlobalSum(): Promise<number> {
    const row = await this.db
      .selectFrom('entries')
      .select(sql<number>`coalesce(sum(amount), 0)`.as('total'))
      .executeTakeFirstOrThrow();

    return Number(row.total);
  }

  /**
   * Every cached balance equals the sum of its account's postings. Returns the
   * accounts where that is not true, which must always be none.
   */
  async findBalanceDrift(): Promise<
    Array<{ accountId: string; key: string; cached: number; computed: number }>
  > {
    const rows = await sql<{
      account_id: string;
      key: string;
      cached: string | number;
      computed: string | number;
    }>`
      SELECT a.id            AS account_id,
             a.key           AS key,
             COALESCE(b.balance, 0) AS cached,
             COALESCE(SUM(e.amount), 0) AS computed
        FROM accounts a
        LEFT JOIN balances b ON b.account_id = a.id
        LEFT JOIN entries  e ON e.account_id = a.id
       GROUP BY a.id, a.key, b.balance
      HAVING COALESCE(b.balance, 0) <> COALESCE(SUM(e.amount), 0)
    `.execute(this.db);

    return rows.rows.map((r) => ({
      accountId: r.account_id,
      key: r.key,
      cached: Number(r.cached),
      computed: Number(r.computed),
    }));
  }

  /** Total virtual credits in circulation = everything MINT has issued. */
  async getCreditsInCirculation(): Promise<Money> {
    const mint = await this.getBalance(SYSTEM_ACCOUNTS.MINT);
    // MINT holds the negative of everything it has issued.
    return Money.negate(mint);
  }
}
