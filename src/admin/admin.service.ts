import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { Money } from '../common/value-objects/money';
import { DatabaseService } from '../database/database.service';
import { SYSTEM_ACCOUNTS } from '../database/database.types';
import { LedgerService } from '../ledger/ledger.service';

/**
 * Operator view (PRD 5.5).
 *
 * Read-only by design. There is no endpoint here that moves money, adjusts a
 * balance or settles a bet — an operator who can silently credit an account is
 * exactly what the ledger exists to rule out, and adding one would undo the
 * guarantee the rest of the system is built on. If a correction were ever
 * needed it would be a posted, referenced ledger transaction like any other,
 * not an admin button.
 *
 * Every figure below is derived from the ledger rather than tracked separately,
 * so the dashboard cannot disagree with the books.
 */
@Injectable()
export class AdminService {
  constructor(
    private readonly database: DatabaseService,
    private readonly ledger: LedgerService,
  ) {}

  private get db() {
    return this.database.db;
  }

  async getOverview() {
    const [circulation, house, escrow, globalSum, drift] = await Promise.all([
      this.ledger.getCreditsInCirculation(),
      this.ledger.getBalance(SYSTEM_ACCOUNTS.HOUSE),
      this.ledger.getBalance(SYSTEM_ACCOUNTS.ESCROW),
      this.ledger.getGlobalSum(),
      this.ledger.findBalanceDrift(),
    ]);

    const [counts, liveRounds, recent] = await Promise.all([
      this.counts(),
      this.liveRounds(),
      this.recentRounds(8),
    ]);

    return {
      ledger: {
        // Everything MINT has ever issued. The only way credits enter the system.
        creditsInCirculation: Money.format(circulation),
        creditsInCirculationMinor: Number(circulation),
        /**
         * Positive means the house is up. Negative is normal and expected —
         * it simply means players are collectively ahead right now.
         */
        housePnl: Money.format(house),
        housePnlMinor: Number(house),
        /** Staked and not yet resolved. The operator's live exposure. */
        exposure: Money.format(escrow),
        exposureMinor: Number(escrow),
        /** Both must be zero. If either is not, the system's core claim is false. */
        globalPostingSum: globalSum,
        driftingAccounts: drift.length,
        healthy: globalSum === 0 && drift.length === 0,
      },
      counts,
      liveRounds,
      recentRounds: recent,
    };
  }

  private async counts() {
    const row = await sql<{
      users: number;
      rounds: number;
      bets: number;
      postings: number;
    }>`
      SELECT (SELECT count(*) FROM users)   AS users,
             (SELECT count(*) FROM rounds)  AS rounds,
             (SELECT count(*) FROM bets)    AS bets,
             (SELECT count(*) FROM entries) AS postings
    `.execute(this.db);

    const first = row.rows[0];
    return {
      users: Number(first?.users ?? 0),
      rounds: Number(first?.rounds ?? 0),
      bets: Number(first?.bets ?? 0),
      postings: Number(first?.postings ?? 0),
    };
  }

  /** Whatever is open or running on each table right now. */
  private async liveRounds() {
    const rows = await this.db
      .selectFrom('rounds')
      .leftJoin('bets', 'bets.round_id', 'rounds.id')
      .select([
        'rounds.id as id',
        'rounds.game as game',
        'rounds.status as status',
        'rounds.nonce as nonce',
        'rounds.locks_at as locks_at',
      ])
      .select((eb) => eb.fn.count<number>('bets.id').as('bet_count'))
      .select((eb) => eb.fn.coalesce(eb.fn.sum<number>('bets.stake_minor'), sql<number>`0`).as('staked'))
      .where('rounds.status', 'in', ['OPEN', 'LOCKED', 'RUNNING'])
      .groupBy(['rounds.id', 'rounds.game', 'rounds.status', 'rounds.nonce', 'rounds.locks_at'])
      .execute();

    return rows.map((row) => ({
      id: row.id,
      game: row.game,
      status: row.status,
      nonce: Number(row.nonce),
      bets: Number(row.bet_count),
      // Exposure attributable to this round specifically.
      stakedMinor: Number(row.staked),
      staked: Money.format(Money.fromMinor(Number(row.staked))),
      locksAt: row.locks_at.toISOString(),
    }));
  }

  private async recentRounds(limit: number) {
    const rows = await this.db
      .selectFrom('rounds')
      .select([
        'id',
        'game',
        'status',
        'nonce',
        'crash_point_bp',
        'winning_pocket',
        'settled_at',
      ])
      .where('status', 'in', ['RESOLVED', 'SETTLED', 'VOIDED'])
      .orderBy('nonce', 'desc')
      .limit(limit)
      .execute();

    return rows.map((row) => ({
      id: row.id,
      game: row.game,
      status: row.status,
      nonce: Number(row.nonce),
      crashPointBp: row.crash_point_bp,
      winningPocket: row.winning_pocket,
      settledAt: row.settled_at?.toISOString() ?? null,
    }));
  }

  /**
   * Players, with balances read from the ledger cache.
   *
   * Offset paging is fine here and wrong for the ledger: this is a bounded set
   * ordered by a stable key, not an append-only log a reader can be shifted
   * through mid-page.
   */
  async listUsers(options: { limit: number; offset: number; search?: string }) {
    const limit = Math.min(Math.max(options.limit, 1), 100);

    let query = this.db
      .selectFrom('users')
      .leftJoin('accounts', (join) =>
        join.onRef('accounts.owner_user_id', '=', 'users.id').on('accounts.kind', '=', 'WALLET'),
      )
      .leftJoin('balances', 'balances.account_id', 'accounts.id')
      .select([
        'users.id as id',
        'users.email as email',
        'users.display_name as display_name',
        'users.role as role',
        'users.status as status',
        'users.created_at as created_at',
        'balances.balance as balance',
      ]);

    if (options.search) {
      query = query.where((eb) =>
        eb.or([
          eb('users.email', 'ilike', `%${options.search}%`),
          eb('users.display_name', 'ilike', `%${options.search}%`),
        ]),
      );
    }

    const rows = await query
      .orderBy('users.created_at', 'desc')
      .limit(limit)
      .offset(Math.max(options.offset, 0))
      .execute();

    const total = await this.db
      .selectFrom('users')
      .select(sql<number>`count(*)`.as('total'))
      .executeTakeFirstOrThrow();

    return {
      users: rows.map((row) => ({
        id: row.id,
        email: row.email,
        displayName: row.display_name,
        role: row.role,
        status: row.status,
        balanceMinor: Number(row.balance ?? 0),
        balance: Money.format(Money.fromMinor(Number(row.balance ?? 0))),
        createdAt: row.created_at.toISOString(),
      })),
      total: Number(total.total),
    };
  }

  /**
   * How credits are spread across players.
   *
   * Useful for spotting the shape a dashboard number hides: a healthy mean with
   * one account holding everything is a different system from an even spread.
   */
  async getBalanceDistribution() {
    const rows = await sql<{ bucket: string; players: number }>`
      SELECT CASE
               WHEN b.balance = 0            THEN 'empty'
               WHEN b.balance < 50000        THEN 'under 500'
               WHEN b.balance < 100000       THEN '500–1,000'
               WHEN b.balance < 250000       THEN '1,000–2,500'
               WHEN b.balance < 1000000      THEN '2,500–10,000'
               ELSE 'over 10,000'
             END AS bucket,
             count(*) AS players
        FROM accounts a
        JOIN balances b ON b.account_id = a.id
       WHERE a.kind = 'WALLET'
       GROUP BY 1
    `.execute(this.db);

    const order = ['empty', 'under 500', '500–1,000', '1,000–2,500', '2,500–10,000', 'over 10,000'];

    return order
      .map((bucket) => ({
        bucket,
        players: Number(rows.rows.find((row) => row.bucket === bucket)?.players ?? 0),
      }))
      .filter((entry) => entry.players > 0);
  }
}
