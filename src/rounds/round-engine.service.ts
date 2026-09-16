import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { elapsedAtMultiplier, TICK_MS } from '@tessera/contracts';
import { sql, type Transaction } from 'kysely';
import { Money } from '../common/value-objects/money';
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
    const live = await this.db
      .selectFrom('rounds')
      .selectAll()
      .where('status', 'in', ['OPEN', 'LOCKED', 'FLYING', 'CRASHED'])
      .orderBy('nonce', 'desc')
      .executeTakeFirst();

    if (!live) {
      await this.openRoundIfDue();
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

      case 'FLYING': {
        if (!live.started_at) return;

        const elapsed = now - live.started_at.getTime();
        const crashAfterMs = elapsedAtMultiplier(live.crash_point_bp);
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
          await this.crashRound(live.id);
        }
        return;
      }

      case 'CRASHED':
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
  async openRoundIfDue(): Promise<string | null> {
    const intermission = this.config.get('ROUND_INTERMISSION_MS', { infer: true });

    const lastSettled = await this.db
      .selectFrom('rounds')
      .select(['settled_at'])
      .where('status', '=', 'SETTLED')
      .orderBy('nonce', 'desc')
      .executeTakeFirst();

    if (lastSettled?.settled_at) {
      const now = await this.serverNow();
      if (now - lastSettled.settled_at.getTime() < intermission) return null;
    }

    const nextNonce = await this.peekNextNonce();
    const outcome = await this.fairness.drawOutcome(nextNonce);
    const bettingWindow = this.config.get('ROUND_BETTING_WINDOW_MS', { infer: true });

    try {
      const round = await this.db
        .insertInto('rounds')
        .values({
          seed: outcome.seed,
          seed_hash: outcome.seedHash,
          seed_revealed: null,
          crash_point_bp: outcome.crashPointBp,
          chain_id: outcome.chainId ?? null,
          chain_index: outcome.chainIndex ?? null,
          locks_at: new Date(Date.now() + bettingWindow),
        })
        .returning(['id', 'nonce'])
        .executeTakeFirstOrThrow();

      await this.events.publish({ type: 'round.state', roundId: round.id });
      this.logger.log(`Round ${round.nonce} open for ${bettingWindow}ms`);
      return round.id;
    } catch (error) {
      // The partial unique index permits only one live round. If a second
      // process somehow got this far, it loses here rather than creating a
      // duplicate — the database is the backstop for leader election.
      if (isUniqueViolation(error, 'rounds_single_live_round')) {
        this.logger.warn('A live round already exists; not opening another');
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
        .set({ status: 'FLYING', started_at: sql<Date>`clock_timestamp()` })
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
  async crashRound(roundId: string): Promise<void> {
    const round = await this.db
      .selectFrom('rounds')
      .select(['nonce', 'crash_point_bp', 'seed'])
      .where('id', '=', roundId)
      .executeTakeFirstOrThrow();

    await this.db.transaction().execute(async (trx) => {
      const changed = await trx
        .updateTable('rounds')
        .set({
          status: 'CRASHED',
          crashed_at: sql<Date>`clock_timestamp()`,
          // The reveal. Copying the committed seed across is what a player checks
          // against the hash published before they bet.
          seed_revealed: round.seed,
        })
        .where('id', '=', roundId)
        .where('status', '=', 'FLYING')
        .executeTakeFirst();

      if (changed.numUpdatedRows === 1n) {
        await this.events.publish({ type: 'round.state', roundId }, trx);
      }
    });

    this.logger.log(
      `Round ${round.nonce} crashed at ${(round.crash_point_bp / 10_000).toFixed(2)}x`,
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
        .select(['id', 'nonce', 'status'])
        .where('id', '=', roundId)
        .forUpdate()
        .executeTakeFirst();

      if (!round || round.status !== 'CRASHED') return;

      // Locked before settling, so a cash-out arriving mid-resolution either
      // lands first and is skipped here, or blocks and finds the bet already
      // LOST. It can never be both paid and written off.
      const activeBets = await trx
        .selectFrom('bets')
        .select(['id', 'user_id', 'stake_minor'])
        .where('round_id', '=', roundId)
        .where('status', '=', 'ACTIVE')
        .forUpdate()
        .execute();

      for (const bet of activeBets) {
        await this.settleLostBet(trx, bet);
      }

      await trx
        .updateTable('rounds')
        .set({ status: 'SETTLED', settled_at: sql<Date>`clock_timestamp()` })
        .where('id', '=', roundId)
        .where('status', '=', 'CRASHED')
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
