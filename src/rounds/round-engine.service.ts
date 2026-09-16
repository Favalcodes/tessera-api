import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  elapsedAtMultiplier,
  GameKind,
  roulettePocketFromHash,
  selectionWins,
  TICK_MS,
  type RouletteBetType,
} from '@tessera/contracts';
import { createHmac } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { BasisPoints, Money } from '../common/value-objects/money';
import type { Env } from '../config/env.validation';
import { DatabaseService } from '../database/database.service';
import { SYSTEM_ACCOUNTS, type DB } from '../database/database.types';
import { LedgerService } from '../ledger/ledger.service';
import { TransactionKind } from '../ledger/ledger.types';
import { RoundEventBusService } from './events/round-event-bus.service';
import { toBetView } from './bet-view.mapper';
import { FAIRNESS_PROVIDER, type FairnessProvider } from './fairness/fairness.provider';
import { LeaderElectionService } from './leader-election.service';

/**
 * The round engine: the only thing that advances a round's state.
 *
 * Deliberately has no transport dependencies. It does not import a gateway, know
 * what a WebSocket is, or care who is watching — Phase 3 will subscribe to it
 * rather than change it. That separation is the point: the concurrency and
 * settlement work here is testable without a socket client anywhere near it.
 *
 *   OPEN ──15s──▶ LOCKED ──▶ FLYING ──▶ CRASHED ──▶ SETTLED ──▶ (next round)
 */
@Injectable()
export class RoundEngineService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RoundEngineService.name);

  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopped = false;

  constructor(
    private readonly database: DatabaseService,
    private readonly ledger: LedgerService,
    private readonly leader: LeaderElectionService,
    private readonly events: RoundEventBusService,
    private readonly config: ConfigService<Env, true>,
    @Inject(FAIRNESS_PROVIDER) private readonly fairness: FairnessProvider,
  ) {}

  private get db() {
    return this.database.db;
  }

  async onApplicationBootstrap(): Promise<void> {
    // Tests drive the engine explicitly rather than having it run underneath
    // them; a loop opening rounds mid-assertion makes failures unreadable.
    if (this.config.get('NODE_ENV', { infer: true }) === 'test') return;

    const isLeader = await this.leader.tryAcquire();
    if (!isLeader) return;

    this.start();
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => void this.safeTick(), TICK_MS);
    this.logger.log(`Round engine started (tick ${TICK_MS}ms)`);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.leader.release();
  }

  private async safeTick(): Promise<void> {
    // Ticks must not overlap. A slow settlement would otherwise be re-entered by
    // the next interval and resolve the same bets twice.
    if (this.ticking || this.stopped) return;
    this.ticking = true;

    try {
      await this.tick();
    } catch (error) {
      this.logger.error('Round engine tick failed', error instanceof Error ? error.stack : error);
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Advance the world by one step. Idempotent and safe to call at any moment —
   * every transition is guarded on the current state, so a tick that arrives
   * late, early or twice does the same thing.
   */
  async tick(): Promise<void> {
    // Both tables run at once. They share a lifecycle and an engine; only the
    // outcome and the settlement differ.
    for (const game of [GameKind.CRASH, GameKind.ROULETTE]) {
      await this.tickGame(game);
    }
  }

  private async tickGame(game: GameKind): Promise<void> {
    const live = await this.db
      .selectFrom('rounds')
      .selectAll()
      .where('game', '=', game)
      .where('status', 'in', ['OPEN', 'LOCKED', 'RUNNING', 'RESOLVED'])
      .orderBy('nonce', 'desc')
      .executeTakeFirst();

    if (!live) {
      await this.openRoundIfDue(game);
      return;
    }

    const now = await this.serverNow();

    switch (live.status) {
      case 'OPEN':
        if (now >= live.locks_at.getTime()) await this.lockRound(live.id);
        return;

      case 'LOCKED':
        await this.startRound(live.id);
        return;

      case 'RUNNING': {
        if (!live.started_at) return;

        const elapsed = now - live.started_at.getTime();
        // Crash runs until the curve reaches its drawn crash point. Roulette
        // runs for a fixed spin: the pocket was decided when the round opened,
        // so the duration is presentation, not outcome.
        const crashAfterMs =
          live.game === GameKind.CRASH
            ? elapsedAtMultiplier(live.crash_point_bp ?? 0)
            : this.config.get('ROULETTE_SPIN_MS', { infer: true });
        const grace = this.config.get('ROUND_STALE_GRACE_MS', { infer: true });

        // Far past the crash point means nobody was resolving this round — the
        // engine was down. Crashing it now would mark every still-active bet as
        // lost, charging players for a round they had no opportunity to cash out
        // of. Refund instead.
        if (elapsed >= crashAfterMs + grace) {
          await this.voidRound(live.id, `engine was not running; ${elapsed - crashAfterMs}ms late`);
          return;
        }

        if (elapsed >= crashAfterMs) {
          await this.resolveRound(live.id);
        }
        return;
      }

      case 'RESOLVED':
        await this.settleRound(live.id);
        return;
    }
  }

  private async serverNow(): Promise<number> {
    const { rows } = await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(this.db);
    return (rows[0]?.now ?? new Date()).getTime();
  }

  // ---------------------------------------------------------------------------
  // Transitions
  // ---------------------------------------------------------------------------

  /**
   * Open a new round, drawing its outcome before a single bet exists.
   *
   * The crash point is stored now and withheld from API responses until the
   * round crashes. Deciding it up front is what makes the fairness claim
   * meaningful — the outcome cannot respond to how people bet.
   */
  async openRoundIfDue(game: GameKind = GameKind.CRASH): Promise<string | null> {
    const intermission = this.config.get('ROUND_INTERMISSION_MS', { infer: true });

    const lastSettled = await this.db
      .selectFrom('rounds')
      .select(['settled_at'])
      .where('game', '=', game)
      .where('status', 'in', ['SETTLED', 'VOIDED'])
      .orderBy('nonce', 'desc')
      .executeTakeFirst();

    if (lastSettled?.settled_at) {
      const now = await this.serverNow();
      if (now - lastSettled.settled_at.getTime() < intermission) return null;
    }

    const nextNonce = await this.peekNextNonce();
    const outcome = await this.fairness.drawOutcome(nextNonce);
    const bettingWindow = this.config.get('ROUND_BETTING_WINDOW_MS', { infer: true });

    // Both outcomes come from the same committed seed. Roulette's pocket is
    // derived from the same HMAC the crash point uses, so one chain covers both
    // tables and a player verifies either the same way.
    const pocket =
      game === GameKind.ROULETTE
        ? roulettePocketFromHash(
            createHmac('sha256', outcome.seed).update(String(nextNonce)).digest('hex'),
          )
        : null;

    try {
      const round = await this.db
        .insertInto('rounds')
        .values({
          game,
          seed: outcome.seed,
          seed_hash: outcome.seedHash,
          seed_revealed: null,
          crash_point_bp: game === GameKind.CRASH ? outcome.crashPointBp : null,
          winning_pocket: pocket,
          chain_id: outcome.chainId ?? null,
          chain_index: outcome.chainIndex ?? null,
          locks_at: new Date(Date.now() + bettingWindow),
        })
        .returning(['id', 'nonce'])
        .executeTakeFirstOrThrow();

      await this.events.publish({ type: 'round.state', roundId: round.id });
      this.logger.log(`${game} round ${round.nonce} open for ${bettingWindow}ms`);
      return round.id;
    } catch (error) {
      // The partial unique index permits only one live round. If a second
      // process somehow got this far, it loses here rather than creating a
      // duplicate — the database is the backstop for leader election.
      if (isUniqueViolation(error, 'rounds_single_live_round_per_game')) {
        this.logger.warn(`A live ${game} round already exists; not opening another`);
        return null;
      }
      throw error;
    }
  }

  private async peekNextNonce(): Promise<number> {
    const { rows } = await sql<{ next: number }>`
      SELECT COALESCE(MAX(nonce), 0) + 1 AS next FROM rounds
    `.execute(this.db);
    return Number(rows[0]?.next ?? 1);
  }

  async lockRound(roundId: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const changed = await trx
        .updateTable('rounds')
        .set({ status: 'LOCKED' })
        .where('id', '=', roundId)
        .where('status', '=', 'OPEN')
        .executeTakeFirst();

      // Publishing inside the transaction keeps the event and the state change
      // atomic; guarding on the row count keeps a no-op tick from broadcasting.
      if (changed.numUpdatedRows === 1n) {
        await this.events.publish({ type: 'round.state', roundId }, trx);
      }
    });
  }

  async startRound(roundId: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const changed = await trx
        .updateTable('rounds')
        .set({ status: 'RUNNING', started_at: sql<Date>`clock_timestamp()` })
        .where('id', '=', roundId)
        .where('status', '=', 'LOCKED')
        .executeTakeFirst();

      if (changed.numUpdatedRows === 1n) {
        await this.events.publish({ type: 'round.state', roundId }, trx);
      }
    });
  }

  /**
   * Crash the round and reveal its seed.
   *
   * The reveal happens here and nowhere earlier — a database constraint refuses
   * a revealed seed on a round that has not crashed, so this ordering is
   * enforced rather than merely intended.
   */
  async resolveRound(roundId: string): Promise<void> {
    const round = await this.db
      .selectFrom('rounds')
      .select(['nonce', 'game', 'crash_point_bp', 'winning_pocket', 'seed'])
      .where('id', '=', roundId)
      .executeTakeFirstOrThrow();

    await this.db.transaction().execute(async (trx) => {
      const changed = await trx
        .updateTable('rounds')
        .set({
          status: 'RESOLVED',
          resolved_at: sql<Date>`clock_timestamp()`,
          // The reveal. Copying the committed seed across is what a player checks
          // against the hash published before they bet.
          seed_revealed: round.seed,
        })
        .where('id', '=', roundId)
        .where('status', '=', 'RUNNING')
        .executeTakeFirst();

      if (changed.numUpdatedRows === 1n) {
        await this.events.publish({ type: 'round.state', roundId }, trx);
      }
    });

    this.logger.log(
      round.game === GameKind.CRASH
        ? `Crash round ${round.nonce} resolved at ${((round.crash_point_bp ?? 0) / 10_000).toFixed(2)}x`
        : `Roulette round ${round.nonce} landed on ${round.winning_pocket}`,
    );
  }

  /**
   * Settle every bet still in the round, then close it.
   *
   * Active bets at the crash have lost: their stake moves from escrow to the
   * house. Each bet is posted as its own ledger transaction referencing that
   * bet, so the audit trail reads per-bet rather than as one opaque lump.
   */
  async settleRound(roundId: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const round = await trx
        .selectFrom('rounds')
        .select(['id', 'nonce', 'status', 'game', 'winning_pocket'])
        .where('id', '=', roundId)
        .forUpdate()
        .executeTakeFirst();

      if (!round || round.status !== 'RESOLVED') return;

      // Locked before settling, so a cash-out arriving mid-resolution either
      // lands first and is skipped here, or blocks and finds the bet already
      // LOST. It can never be both paid and written off.
      const activeBets = await trx
        .selectFrom('bets')
        .selectAll()
        .where('round_id', '=', roundId)
        .where('status', '=', 'ACTIVE')
        .forUpdate()
        .execute();

      for (const bet of activeBets) {
        if (round.game === GameKind.ROULETTE) {
          await this.settleRouletteBet(trx, bet, round.winning_pocket ?? 0);
        } else {
          // Crash: anyone still in at the crash has lost. Winners left earlier,
          // by cashing out.
          await this.settleLostBet(trx, bet);
        }
      }

      await trx
        .updateTable('rounds')
        .set({ status: 'SETTLED', settled_at: sql<Date>`clock_timestamp()` })
        .where('id', '=', roundId)
        .where('status', '=', 'RESOLVED')
        .execute();

      await this.events.publish({ type: 'round.state', roundId }, trx);
      this.logger.log(`Round ${round.nonce} settled (${activeBets.length} lost)`);
    });
  }

  /**
   * Abandon a round and return every stake.
   *
   * The failure this exists for is an engine outage mid-flight. On restart the
   * round is long past its crash point, and resolving it normally would write
   * off every active bet — the player was charged for a round they could not
   * act in. Voiding returns the stakes from escrow and leaves the books square.
   *
   * The seed is revealed even though the outcome was discarded. Voiding is the
   * only power the operator has to make a round not count, so an operator able
   * to void silently could dodge expensive payouts by voiding whenever the drawn
   * outcome was costly. Revealing makes every void auditable against what it
   * discarded.
   */
  async voidRound(roundId: string, reason: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const round = await trx
        .selectFrom('rounds')
        .select(['id', 'nonce', 'status', 'seed'])
        .where('id', '=', roundId)
        .forUpdate()
        .executeTakeFirst();

      if (!round || round.status === 'VOIDED' || round.status === 'SETTLED') return;

      const activeBets = await trx
        .selectFrom('bets')
        .select(['id', 'user_id', 'stake_minor'])
        .where('round_id', '=', roundId)
        .where('status', '=', 'ACTIVE')
        .forUpdate()
        .execute();

      for (const bet of activeBets) {
        await this.refundBet(trx, bet);
      }

      await trx
        .updateTable('rounds')
        .set({
          status: 'VOIDED',
          seed_revealed: round.seed,
          settled_at: sql<Date>`clock_timestamp()`,
        })
        .where('id', '=', roundId)
        .execute();

      await this.events.publish({ type: 'round.state', roundId }, trx);
      this.logger.warn(
        `Round ${round.nonce} voided (${reason}); refunded ${activeBets.length} stake(s)`,
      );
    });
  }

  private async refundBet(
    trx: Transaction<DB>,
    bet: { id: string; user_id: string; stake_minor: number },
  ): Promise<void> {
    const stake = Money.fromMinor(bet.stake_minor);

    await trx
      .updateTable('bets')
      .set({
        status: 'VOIDED',
        payout_minor: stake,
        settled_at: sql<Date>`clock_timestamp()`,
      })
      .where('id', '=', bet.id)
      .where('status', '=', 'ACTIVE')
      .execute();

    const walletId = await this.ledger.getWalletAccountId(bet.user_id, trx);

    // Straight back out of escrow. The house is not involved: no outcome was
    // used, so nobody won or lost anything.
    await this.ledger.post(
      {
        kind: TransactionKind.ROUND_VOID_REFUND,
        reference: { type: 'bet', id: bet.id },
        postings: [
          { accountId: SYSTEM_ACCOUNTS.ESCROW, amount: Money.negate(stake) },
          { accountId: walletId, amount: stake },
        ],
      },
      trx,
    );

    await this.publishBetOutcome(trx, bet.id, bet.user_id, walletId);
  }

  /**
   * Tell one player what happened to their bet, and what their balance is now.
   *
   * Sent on the same transaction as the settlement, so a client cannot be told
   * about a payout that then rolls back.
   */
  private async publishBetOutcome(
    trx: Transaction<DB>,
    betId: string,
    userId: string,
    walletId: string,
  ): Promise<void> {
    const row = await trx
      .selectFrom('bets')
      .selectAll()
      .where('id', '=', betId)
      .executeTakeFirstOrThrow();

    const balance = await this.ledger.getBalance(walletId, trx);

    await this.events.publish({ type: 'bet.settled', userId, bet: toBetView(row) }, trx);
    await this.events.publish({ type: 'wallet.updated', userId, balanceMinor: balance }, trx);
  }

  /**
   * Settle one roulette bet against the pocket that came up.
   *
   * Every bet on the table is evaluated by the same shared rules the client uses
   * to price it, so a player can predict the settlement exactly. Winners are
   * paid their stake back out of escrow plus profit from the house; losers'
   * stakes move from escrow to the house, exactly as in crash.
   */
  private async settleRouletteBet(
    trx: Transaction<DB>,
    bet: {
      id: string;
      user_id: string;
      stake_minor: number;
      selection_type: string | null;
      selection_value: string | null;
      odds_bp: number | null;
    },
    pocket: number,
  ): Promise<void> {
    const selection = {
      type: bet.selection_type as RouletteBetType,
      ...(bet.selection_value === null ? {} : { value: Number(bet.selection_value) }),
    };

    if (!bet.selection_type || bet.odds_bp === null || !selectionWins(selection, pocket)) {
      await this.settleLostBet(trx, bet);
      return;
    }

    const stake = Money.fromMinor(bet.stake_minor);
    // Paid at the odds stored on the bet, not at today's odds table.
    const payout = Money.applyMultiplier(stake, BasisPoints.fromRaw(bet.odds_bp));
    const profit = Money.sub(payout, stake);

    await trx
      .updateTable('bets')
      .set({
        status: 'WON',
        settled_multiplier_bp: bet.odds_bp,
        payout_minor: payout,
        settled_at: sql<Date>`clock_timestamp()`,
      })
      .where('id', '=', bet.id)
      .where('status', '=', 'ACTIVE')
      .execute();

    const walletId = await this.ledger.getWalletAccountId(bet.user_id, trx);

    const postings = [
      { accountId: SYSTEM_ACCOUNTS.ESCROW, amount: Money.negate(stake) },
      { accountId: walletId, amount: stake },
    ];

    if (Money.isPositive(profit)) {
      postings.push(
        { accountId: SYSTEM_ACCOUNTS.HOUSE, amount: Money.negate(profit) },
        { accountId: walletId, amount: profit },
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

    const displayName = await this.displayNameOf(trx, bet.user_id);

    await this.events.publish(
      {
        type: 'bet.won',
        roundId: (await this.roundIdOf(trx, bet.id)) ?? '',
        game: GameKind.ROULETTE,
        betId: bet.id,
        displayName,
        stakeMinor: bet.stake_minor,
        selection: { type: selection.type, ...(selection.value === undefined ? {} : { value: selection.value }) },
        settledMultiplierBp: bet.odds_bp,
        payoutMinor: payout,
      },
      trx,
    );

    await this.publishBetOutcome(trx, bet.id, bet.user_id, walletId);
  }

  private async displayNameOf(trx: Transaction<DB>, userId: string): Promise<string> {
    const row = await trx
      .selectFrom('users')
      .select(['display_name'])
      .where('id', '=', userId)
      .executeTakeFirst();
    return row?.display_name ?? 'Player';
  }

  private async roundIdOf(trx: Transaction<DB>, betId: string): Promise<string | null> {
    const row = await trx
      .selectFrom('bets')
      .select(['round_id'])
      .where('id', '=', betId)
      .executeTakeFirst();
    return row?.round_id ?? null;
  }

  private async settleLostBet(
    trx: Transaction<DB>,
    bet: { id: string; user_id: string; stake_minor: number },
  ): Promise<void> {
    const stake = Money.fromMinor(bet.stake_minor);

    await trx
      .updateTable('bets')
      .set({ status: 'LOST', payout_minor: 0, settled_at: sql<Date>`clock_timestamp()` })
      .where('id', '=', bet.id)
      .where('status', '=', 'ACTIVE')
      .execute();

    await this.ledger.post(
      {
        kind: TransactionKind.BET_LOST,
        reference: { type: 'bet', id: bet.id },
        postings: [
          { accountId: SYSTEM_ACCOUNTS.ESCROW, amount: Money.negate(stake) },
          { accountId: SYSTEM_ACCOUNTS.HOUSE, amount: stake },
        ],
      },
      trx,
    );

    const walletId = await this.ledger.getWalletAccountId(bet.user_id, trx);
    await this.publishBetOutcome(trx, bet.id, bet.user_id, walletId);
  }
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate.code === '23505' && candidate.constraint === constraint;
}
