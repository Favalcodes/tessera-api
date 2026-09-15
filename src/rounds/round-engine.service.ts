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
        const crashAfterMs = elapsedAtMultiplier(live.crash_point_bp);
        if (now - live.started_at.getTime() >= crashAfterMs) {
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
          locks_at: new Date(Date.now() + bettingWindow),
        })
        .returning(['id', 'nonce'])
        .executeTakeFirstOrThrow();

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
    await this.db
      .updateTable('rounds')
      .set({ status: 'LOCKED' })
      .where('id', '=', roundId)
      .where('status', '=', 'OPEN')
      .execute();
  }

  async startRound(roundId: string): Promise<void> {
    await this.db
      .updateTable('rounds')
      .set({ status: 'FLYING', started_at: sql<Date>`clock_timestamp()` })
      .where('id', '=', roundId)
      .where('status', '=', 'LOCKED')
      .execute();
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

    await this.db
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
      .execute();

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

      this.logger.log(`Round ${round.nonce} settled (${activeBets.length} lost)`);
    });
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
  }
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate.code === '23505' && candidate.constraint === constraint;
}
