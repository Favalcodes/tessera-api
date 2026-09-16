import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  assertValidSelection,
  describeSelection,
  multiplierAtElapsed,
  oddsForSelection,
  RouletteSelectionError,
  type BetView,
  type GameKind,
  type RoundStatus,
  type RouletteSelection,
  type RoundView,
} from '@tessera/contracts';
import { sql, type Transaction } from 'kysely';
import { BasisPoints, Money } from '../common/value-objects/money';
import type { Env } from '../config/env.validation';
import { DatabaseService } from '../database/database.service';
import { SYSTEM_ACCOUNTS, type DB } from '../database/database.types';
import { LedgerService } from '../ledger/ledger.service';
import { TransactionKind, type Executor } from '../ledger/ledger.types';
import { toBetView, type BetRow } from './bet-view.mapper';
import { RoundEventBusService } from './events/round-event-bus.service';
import {
  BetAlreadySettledError,
  CashOutTooLateError,
  GameDoesNotSupportCashOutError,
  InvalidSelectionError,
  NoActiveRoundError,
  NoBetOnRoundError,
  RoundNotRunningError,
  RoundNotFoundError,
  RoundNotOpenError,
  StakeOutOfRangeError,
} from './exceptions/rounds.exceptions';

type RoundRow = {
  id: string;
  nonce: number;
  game: string;
  status: string;
  seed_hash: string;
  seed_revealed: string | null;
  crash_point_bp: number | null;
  winning_pocket: number | null;
  opens_at: Date;
  locks_at: Date;
  started_at: Date | null;
  resolved_at: Date | null;
};

/**
 * Betting on a round: the two concurrency-critical write paths.
 *
 * Deliberately transport-agnostic — no gateway, no WebSocket, no HTTP types.
 * Phase 3 adds a real-time layer on top of this without changing any of it.
 */
@Injectable()
export class RoundsService {
  private readonly logger = new Logger(RoundsService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly ledger: LedgerService,
    private readonly events: RoundEventBusService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  private get db() {
    return this.database.db;
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  async getCurrentRound(): Promise<RoundView> {
    const row = await this.db
      .selectFrom('rounds')
      .selectAll()
      .where('status', 'in', ['OPEN', 'LOCKED', 'RUNNING'])
      .orderBy('nonce', 'desc')
      .executeTakeFirst();

    if (!row) throw new NoActiveRoundError();
    return this.toRoundView(row);
  }

  async getRound(roundId: string): Promise<RoundView> {
    const row = await this.db
      .selectFrom('rounds')
      .selectAll()
      .where('id', '=', roundId)
      .executeTakeFirst();

    if (!row) throw new RoundNotFoundError(roundId);
    return this.toRoundView(row);
  }

  async getUserBetsForRound(userId: string, roundId: string): Promise<BetView[]> {
    const rows = await this.db
      .selectFrom('bets')
      .selectAll()
      .where('user_id', '=', userId)
      .where('round_id', '=', roundId)
      .orderBy('created_at', 'asc')
      .execute();

    return rows.map((r) => toBetView(r));
  }

  async getUserBets(userId: string, limit = 50): Promise<BetView[]> {
    const rows = await this.db
      .selectFrom('bets')
      .selectAll()
      .where('user_id', '=', userId)
      .orderBy('created_at', 'desc')
      .limit(Math.min(Math.max(limit, 1), 200))
      .execute();

    return rows.map((r) => toBetView(r));
  }

  // ---------------------------------------------------------------------------
  // CONCURRENCY PATH 1 — placing a bet
  // ---------------------------------------------------------------------------

  /**
   * Place a bet.
   *
   * The balance check, the debit and the bet row are one transaction, and the
   * wallet row is locked with `SELECT ... FOR UPDATE` before the balance is
   * read. That is what makes check-then-debit atomic: a second concurrent
   * request blocks on the lock and then sees the post-debit balance rather than
   * the stale one it would otherwise have read. Without the lock, N simultaneous
   * requests all read the same balance and all decide they can afford it.
   *
   * Rows are locked in a fixed order — round, then wallet — matching the order
   * the resolver takes them, so the two cannot deadlock against each other.
   */
  async placeBet(input: {
    userId: string;
    roundId: string;
    stakeMinor: number;
    idempotencyKey: string;
    /** Required for roulette, rejected for crash. */
    selection?: RouletteSelection;
  }): Promise<BetView> {
    const minStake = this.config.get('MIN_STAKE_MINOR', { infer: true });
    const maxStake = this.config.get('MAX_STAKE_MINOR', { infer: true });

    if (input.stakeMinor < minStake || input.stakeMinor > maxStake) {
      throw new StakeOutOfRangeError(minStake, maxStake);
    }

    const stake = Money.fromMinor(input.stakeMinor);

    try {
      return await this.db.transaction().execute(async (trx) => {
        // A replayed request must return the original result, not an error: a
        // client that retried because it never saw the response has to be able
        // to converge on what actually happened.
        const replay = await this.findByIdempotencyKey(trx, input.userId, input.idempotencyKey);
        if (replay) return toBetView(replay);

        // FOR SHARE, not FOR UPDATE.
        //
        // Concurrent bets do not conflict with one another — they conflict with
        // the engine closing the round. A shared lock lets any number of bets
        // proceed in parallel while still blocking the engine's
        // `UPDATE rounds SET status='LOCKED'`, which needs an exclusive lock and
        // therefore waits for every in-flight bet to commit. No bet can slip in
        // after betting closes, and bets do not queue behind each other.
        //
        // An exclusive lock here serialises every bet on the round, which is both
        // a throughput ceiling and — more insidiously — it masks the wallet lock
        // below, since nothing ever reaches it concurrently.
        const round = await trx
          .selectFrom('rounds')
          .select(['id', 'status', 'game'])
          .where('id', '=', input.roundId)
          .forShare()
          .executeTakeFirst();

        if (!round) throw new RoundNotFoundError(input.roundId);
        if (round.status !== 'OPEN') throw new RoundNotOpenError(round.status);

        // The selection is priced here and stored on the bet, rather than looked
        // up again at settlement. That way editing the odds table can never
        // retroactively change what an already-placed bet pays.
        const { selectionType, selectionValue, oddsBp } = this.priceSelection(
          round.game,
          input.selection,
        );

        const walletId = await this.ledger.getWalletAccountId(input.userId, trx);
        await this.ledger.lockAndAssertSufficient(trx, walletId, stake);

        const bet = await trx
          .insertInto('bets')
          .values({
            user_id: input.userId,
            round_id: input.roundId,
            stake_minor: stake,
            idempotency_key: input.idempotencyKey,
            selection_type: selectionType,
            selection_value: selectionValue,
            odds_bp: oddsBp,
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        // The stake leaves the player and sits in escrow for the round. It is
        // not the house's money yet — that is decided at settlement.
        await this.ledger.post(
          {
            kind: TransactionKind.BET_PLACED,
            reference: { type: 'bet', id: bet.id },
            postings: [
              { accountId: walletId, amount: Money.negate(stake) },
              { accountId: SYSTEM_ACCOUNTS.ESCROW, amount: stake },
            ],
          },
          trx,
        );

        const displayName = await this.displayNameOf(input.userId, trx);
        const balance = await this.ledger.getBalance(walletId, trx);

        await this.events.publish(
          {
            type: 'bet.placed',
            roundId: input.roundId,
            game: round.game,
            betId: bet.id,
            displayName,
            stakeMinor: bet.stake_minor,
            ...(input.selection ? { selection: { ...input.selection } } : {}),
          },
          trx,
        );
        await this.events.publish(
          { type: 'wallet.updated', userId: input.userId, balanceMinor: balance },
          trx,
        );

        return toBetView(bet, round.game);
      });
    } catch (error) {
      // Two requests carrying the same idempotency key can both miss the replay
      // check above and race to insert. The unique index is the real arbiter;
      // the loser reads back what the winner wrote.
      if (isUniqueViolation(error, 'bets_user_idempotency')) {
        const existing = await this.findByIdempotencyKey(
          this.db,
          input.userId,
          input.idempotencyKey,
        );
        if (existing) return toBetView(existing);
      }

      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // CONCURRENCY PATH 2 — cashing out
  // ---------------------------------------------------------------------------

  /**
   * Cash out of a round in flight.
   *
   * Two things make this safe. The multiplier is derived from the database
   * clock and the round's own `started_at` — never supplied by the client
   * (ADR-006), because a client-supplied multiplier is a request to be paid an
   * arbitrary amount. And the settlement is a conditional update guarded on the
   * bet still being ACTIVE, so a double-click cannot pay twice: the second
   * update matches no rows and the transaction is refused.
   *
   * The crash check compares the derived multiplier against the round's crash
   * point directly rather than trusting `rounds.status`. That matters: if the
   * engine has not yet ticked the round to CRASHED, the status still says
   * FLYING, and paying out on that basis would pay for a multiplier that never
   * existed.
   */
  async cashOut(input: { userId: string; betId: string }): Promise<BetView> {
    return this.db.transaction().execute(async (trx) => {
      const bet = await trx
        .selectFrom('bets')
        .selectAll()
        .where('id', '=', input.betId)
        .where('user_id', '=', input.userId)
        .forUpdate()
        .executeTakeFirst();

      if (!bet) throw new NoBetOnRoundError();

      // Idempotent: cashing out twice returns the first result rather than
      // erroring, so a retried request converges.
      if (bet.status === 'WON') return toBetView(bet);
      if (bet.status !== 'ACTIVE') throw new BetAlreadySettledError(bet.status);

      const round = await trx
        .selectFrom('rounds')
        .select(['id', 'status', 'game', 'started_at', 'crash_point_bp'])
        .where('id', '=', bet.round_id)
        .executeTakeFirstOrThrow();

      // Cashing out is a crash action. A roulette bet has no such moment: it is
      // placed, the wheel resolves, and it won or it did not.
      if (round.game !== 'CRASH' || round.crash_point_bp === null) {
        throw new GameDoesNotSupportCashOutError(round.game);
      }

      if (round.status !== 'RUNNING' || !round.started_at) {
        throw new RoundNotRunningError(round.status);
      }

      // One clock for every instance. `clock_timestamp()` rather than `now()`,
      // which in Postgres is the transaction start time and would drift.
      const { rows } = await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(trx);
      const serverNow = rows[0]?.now ?? new Date();

      const elapsedMs = serverNow.getTime() - round.started_at.getTime();
      const multiplierBp = multiplierAtElapsed(elapsedMs);

      if (multiplierBp >= round.crash_point_bp) {
        throw new CashOutTooLateError(round.crash_point_bp);
      }

      const stake = Money.fromMinor(bet.stake_minor);
      const payout = Money.applyMultiplier(stake, BasisPoints.fromRaw(multiplierBp));
      const profit = Money.sub(payout, stake);

      const updated = await trx
        .updateTable('bets')
        .set({
          status: 'WON',
          settled_multiplier_bp: multiplierBp,
          payout_minor: payout,
          settled_at: serverNow,
        })
        .where('id', '=', bet.id)
        .where('status', '=', 'ACTIVE')
        .returningAll()
        .executeTakeFirst();

      // Belt and braces alongside the row lock above: if this ever matches
      // nothing, something else settled the bet first and paying out now would
      // double-credit it.
      if (!updated) throw new BetAlreadySettledError('settled');

      const postings = [
        // The stake comes back out of escrow.
        { accountId: SYSTEM_ACCOUNTS.ESCROW, amount: Money.negate(stake) },
        { accountId: await this.ledger.getWalletAccountId(input.userId, trx), amount: stake },
      ];

      if (Money.isPositive(profit)) {
        // Winnings above the stake are the house's loss.
        postings.push(
          { accountId: SYSTEM_ACCOUNTS.HOUSE, amount: Money.negate(profit) },
          { accountId: postings[1]!.accountId, amount: profit },
        );
      }

      await this.ledger.post(
        {
          kind: TransactionKind.BET_CASHOUT,
          reference: { type: 'bet', id: bet.id },
          postings,
        },
        trx,
      );

      const walletId = postings[1]!.accountId;
      const displayName = await this.displayNameOf(input.userId, trx);
      const balance = await this.ledger.getBalance(walletId, trx);

      await this.events.publish(
        {
          type: 'bet.won',
          roundId: bet.round_id,
          game: round.game,
          betId: bet.id,
          displayName,
          stakeMinor: bet.stake_minor,
          settledMultiplierBp: multiplierBp,
          payoutMinor: payout,
        },
        trx,
      );
      await this.events.publish(
        { type: 'wallet.updated', userId: input.userId, balanceMinor: balance },
        trx,
      );
      await this.events.publish(
        { type: 'bet.settled', userId: input.userId, bet: toBetView(updated) },
        trx,
      );

      this.logger.debug(
        `cashed out bet=${bet.id} at ${(multiplierBp / 10_000).toFixed(2)}x payout=${payout}`,
      );

      return toBetView(updated);
    });
  }

  // ---------------------------------------------------------------------------
  // Mapping
  // ---------------------------------------------------------------------------

  /**
   * Validate and price a selection against the game being bet on.
   *
   * Crash has exactly one thing to bet on, so a selection is meaningless there
   * and is rejected rather than ignored — silently dropping it would let a
   * client believe it had backed something specific.
   */
  private priceSelection(
    game: string,
    selection?: RouletteSelection,
  ): { selectionType: string | null; selectionValue: string | null; oddsBp: number | null } {
    if (game === 'CRASH') {
      if (selection) {
        throw new InvalidSelectionError('Crash bets do not take a selection');
      }
      return { selectionType: null, selectionValue: null, oddsBp: null };
    }

    if (!selection) {
      throw new InvalidSelectionError('A roulette bet must name what it is backing');
    }

    try {
      assertValidSelection(selection);
    } catch (error) {
      if (error instanceof RouletteSelectionError) {
        throw new InvalidSelectionError(error.message);
      }
      throw error;
    }

    return {
      selectionType: selection.type,
      selectionValue: selection.value === undefined ? null : String(selection.value),
      oddsBp: oddsForSelection(selection),
    };
  }

  /** How a selection reads in the public feed. */
  describeBetSelection(selection: RouletteSelection): string {
    return describeSelection(selection);
  }

  /** Public feed shows who bet, never their id or balance. */
  private async displayNameOf(userId: string, executor: Executor): Promise<string> {
    const row = await executor
      .selectFrom('users')
      .select(['display_name'])
      .where('id', '=', userId)
      .executeTakeFirst();

    return row?.display_name ?? 'Player';
  }

  private async findByIdempotencyKey(
    executor: Transaction<DB> | typeof this.db,
    userId: string,
    idempotencyKey: string,
  ): Promise<BetRow | undefined> {
    return executor
      .selectFrom('bets')
      .selectAll()
      .where('user_id', '=', userId)
      .where('idempotency_key', '=', idempotencyKey)
      .executeTakeFirst();
  }

  toRoundView(row: RoundRow): RoundView {
    const concluded = row.status === 'RESOLVED' || row.status === 'SETTLED';
    // A voided round reveals its seed too, so voids can be audited against the
    // outcomes they discarded — but it does not report a crash point, because
    // no outcome was used.
    const revealed = concluded || row.status === 'VOIDED';

    return {
      id: row.id,
      game: row.game as GameKind,
      nonce: Number(row.nonce),
      status: row.status as RoundStatus,
      seedHash: row.seed_hash,
      // Withheld until the round concludes. Publishing either earlier would hand
      // a player the outcome before they bet.
      seedRevealed: revealed ? row.seed_revealed : null,
      crashPointBp: concluded ? row.crash_point_bp : null,
      winningPocket: concluded ? row.winning_pocket : null,
      opensAt: row.opens_at.toISOString(),
      locksAt: row.locks_at.toISOString(),
      startedAt: row.started_at?.toISOString() ?? null,
      resolvedAt: row.resolved_at?.toISOString() ?? null,
      serverTime: new Date().toISOString(),
    };
  }
}

/** Narrow a Postgres unique-violation error without an `any` cast. */
function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate.code === '23505' && candidate.constraint === constraint;
}
