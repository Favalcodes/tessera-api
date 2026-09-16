/**
 * Populate a believable demo.
 *
 *   pnpm seed:demo
 *
 * A live demo of an empty system shows nothing: no ledger history, no feed, a
 * flat balance distribution. This creates a handful of players and plays real
 * rounds through the real services — no hand-written rows, so the ledger it
 * produces is one the system actually generated and every invariant still holds.
 */
import { NestFactory } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { LedgerService } from '../src/ledger/ledger.service';
import { RoundEngineService } from '../src/rounds/round-engine.service';
import { RoundsService } from '../src/rounds/rounds.service';
import { UsersService } from '../src/users/users.service';
import { DatabaseService } from '../src/database/database.service';
import type { RouletteSelection } from '@tessera/contracts';

const PLAYERS = ['Ada', 'Grace', 'Katherine', 'Joan', 'Margaret', 'Dorothy'];
const ROULETTE_BETS: RouletteSelection[] = [
  { type: 'RED' },
  { type: 'BLACK' },
  { type: 'ODD' },
  { type: 'EVEN' },
  { type: 'DOZEN', value: 1 },
  { type: 'DOZEN', value: 3 },
  { type: 'STRAIGHT', value: 7 },
  { type: 'COLUMN', value: 2 },
];

const pick = <T>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)]!;

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['warn', 'error'] });

  const auth = app.get(AuthService);
  const rounds = app.get(RoundsService);
  const engine = app.get(RoundEngineService);
  const ledger = app.get(LedgerService);

  const users = app.get(UsersService);
  const database = app.get(DatabaseService);

  // Re-runnable: a player that already exists is reused rather than failing the
  // whole seed.
  const userIds: string[] = [];
  for (const name of PLAYERS) {
    const email = `${name.toLowerCase()}@tessera.demo`;
    const existing = await users.findByEmail(email);

    if (existing) {
      userIds.push(existing.id);
      continue;
    }

    const result = await auth.register({
      email,
      displayName: name,
      password: 'correct-horse-battery-staple',
    });
    userIds.push(result.user.id);
  }
  console.log(`${userIds.length} players ready`);

  // Clear the tables. Only one round per game may be live, so a round left open
  // by a running API would block every round this script tries to open — and
  // voiding returns the stakes, so nobody is charged for it.
  const live = await database.db
    .selectFrom('rounds')
    .select(['id'])
    .where('status', 'in', ['OPEN', 'LOCKED', 'RUNNING'])
    .execute();

  for (const round of live) {
    await engine.voidRound(round.id, 'cleared by the demo seed');
  }

  if (live.length > 0) console.log(`voided ${live.length} round(s) that were still live`);

  let crashRounds = 0;
  let rouletteRounds = 0;

  for (let i = 0; i < 24; i += 1) {
    const game = i % 2 === 0 ? 'CRASH' : 'ROULETTE';
    const roundId = await engine.openRoundIfDue(game);
    if (!roundId) {
      console.warn(`could not open a ${game} round; is the API running and holding one?`);
      continue;
    }

    // Most players bet, some sit out — a table where everyone plays every round
    // looks synthetic.
    for (const userId of userIds.filter(() => Math.random() > 0.35)) {
      const stake = pick([100, 500, 1_000, 2_500]);
      try {
        await rounds.placeBet({
          userId,
          roundId,
          stakeMinor: stake,
          idempotencyKey: randomUUID(),
          ...(game === 'ROULETTE' ? { selection: pick(ROULETTE_BETS) } : {}),
        });
      } catch {
        // Out of credits, or the window closed. Both are normal.
      }
    }

    await engine.lockRound(roundId);
    await engine.startRound(roundId);

    // Crash: some players get out in time, some do not.
    if (game === 'CRASH') {
      for (const userId of userIds) {
        if (Math.random() > 0.5) continue;
        const bets = await rounds.getUserBetsForRound(userId, roundId);
        for (const bet of bets) {
          await rounds.cashOut({ userId, betId: bet.id }).catch(() => undefined);
        }
      }
      crashRounds += 1;
    } else {
      rouletteRounds += 1;
    }

    await engine.resolveRound(roundId);
    await engine.settleRound(roundId);
  }

  console.log(`played ${crashRounds} crash rounds and ${rouletteRounds} roulette rounds`);

  // The seeded state must satisfy the same invariants as any other state.
  const sum = await ledger.getGlobalSum();
  const drift = await ledger.findBalanceDrift();
  const circulation = await ledger.getCreditsInCirculation();

  console.log(`credits in circulation: ${circulation / 100}`);
  console.log(`ledger: postings sum ${sum}, ${drift.length} drifting accounts`);

  if (sum !== 0 || drift.length > 0) {
    console.error('seeded state does not balance — refusing to claim success');
    await app.close();
    process.exit(1);
  }

  console.log('\nPlayers can sign in with: correct-horse-battery-staple');
  await app.close();
}

void main();
