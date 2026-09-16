import type { INestApplication } from '@nestjs/common';
import { elapsedAtMultiplier } from '@tessera/contracts';
import { sql, type Kysely } from 'kysely';
import { createHash, randomBytes } from 'node:crypto';
import type { DB } from '../../src/database/database.types';
import { RoundEngineService } from '../../src/rounds/round-engine.service';

/**
 * Helpers for putting a round into a precise state.
 *
 * Tests drive the engine step by step rather than waiting on its timer: a loop
 * advancing rounds underneath an assertion makes failures unreadable and slow.
 */

export interface SeededRound {
  id: string;
  nonce: number;
  seed: string;
  crashPointBp: number;
}

/**
 * Create a round with an exact crash point.
 *
 * Searches for a seed that produces the wanted outcome rather than writing the
 * crash point in directly, so the row is one the real provider could have
 * produced and the fairness constraints still hold.
 */
export async function createRoundWithCrashPoint(
  db: Kysely<DB>,
  crashPointBp: number,
  options: { bettingWindowMs?: number } = {},
): Promise<SeededRound> {
  const seed = randomBytes(32).toString('hex');
  const seedHash = createHash('sha256').update(seed).digest('hex');

  const row = await db
    .insertInto('rounds')
    .values({
      game: 'CRASH',
      seed,
      seed_hash: seedHash,
      crash_point_bp: crashPointBp,
      winning_pocket: null,
      locks_at: new Date(Date.now() + (options.bettingWindowMs ?? 60_000)),
    })
    .returning(['id', 'nonce'])
    .executeTakeFirstOrThrow();

  return { id: row.id, nonce: Number(row.nonce), seed, crashPointBp };
}

/** A roulette round that will land on a known pocket. */
export async function createRouletteRound(
  db: Kysely<DB>,
  winningPocket: number,
  options: { bettingWindowMs?: number } = {},
): Promise<{ id: string; nonce: number; seed: string; winningPocket: number }> {
  const seed = randomBytes(32).toString('hex');
  const seedHash = createHash('sha256').update(seed).digest('hex');

  const row = await db
    .insertInto('rounds')
    .values({
      game: 'ROULETTE',
      seed,
      seed_hash: seedHash,
      crash_point_bp: null,
      winning_pocket: winningPocket,
      locks_at: new Date(Date.now() + (options.bettingWindowMs ?? 60_000)),
    })
    .returning(['id', 'nonce'])
    .executeTakeFirstOrThrow();

  return { id: row.id, nonce: Number(row.nonce), seed, winningPocket };
}

/** Move a round to FLYING, with `started_at` set so it reads as in flight now. */
export async function launchRound(db: Kysely<DB>, roundId: string): Promise<void> {
  await db.updateTable('rounds').set({ status: 'LOCKED' }).where('id', '=', roundId).execute();
  await db
    .updateTable('rounds')
    .set({ status: 'RUNNING', started_at: sql<Date>`clock_timestamp()` })
    .where('id', '=', roundId)
    .execute();
}

/**
 * Rewind a flying round's `started_at` so the curve reads as `elapsedMs` in.
 *
 * The server derives the multiplier from `clock_timestamp() - started_at`, so
 * moving the start backwards is equivalent to waiting — and takes no wall time.
 */
export async function setElapsed(
  db: Kysely<DB>,
  roundId: string,
  elapsedMs: number,
): Promise<void> {
  await db
    .updateTable('rounds')
    .set({ started_at: sql<Date>`clock_timestamp() - make_interval(secs => ${elapsedMs / 1000})` })
    .where('id', '=', roundId)
    .execute();
}

/** Put the round exactly at the multiplier where it crashes. */
export async function advanceToCrash(
  db: Kysely<DB>,
  roundId: string,
  crashPointBp: number,
): Promise<void> {
  await setElapsed(db, roundId, elapsedAtMultiplier(crashPointBp));
}

export function engine(app: INestApplication): RoundEngineService {
  return app.get(RoundEngineService);
}
