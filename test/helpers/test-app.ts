import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { sql, type Kysely } from 'kysely';
import { AppModule } from '../../src/app.module';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';
import { KYSELY } from '../../src/database/database.service';
import { SYSTEM_ACCOUNTS, type DB } from '../../src/database/database.types';

export interface TestContext {
  app: INestApplication;
  db: Kysely<DB>;
}

export interface TestAppOptions {
  /**
   * Rate limiting is disabled by default so a spec can register dozens of users
   * without tripping the production limit of 5/minute. `auth-throttle.e2e-spec`
   * turns it back on to prove the limiter is actually wired up — otherwise
   * disabling it here would quietly remove the protection from all coverage.
   */
  throttle?: boolean;
}

export async function createTestApp(options: TestAppOptions = {}): Promise<TestContext> {
  // Read per request by ConfigurableThrottlerGuard, so it takes effect for any
  // app built from here regardless of when the DI graph was assembled.
  process.env.THROTTLE_ENABLED = options.throttle ? 'true' : 'false';

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();

  return { app, db: app.get<Kysely<DB>>(KYSELY) };
}

/**
 * Truncate everything and restore the seeded system accounts.
 *
 * TRUNCATE is used rather than DELETE precisely because `entries` has an
 * append-only trigger that (correctly) refuses DELETE. TRUNCATE bypasses
 * row-level triggers, which is what makes it usable here and nowhere else.
 */
export async function resetDatabase(db: Kysely<DB>): Promise<void> {
  await sql`
    TRUNCATE TABLE bets, rounds, refresh_tokens, entries, transactions, balances, accounts, users
    RESTART IDENTITY CASCADE
  `.execute(db);

  await db
    .insertInto('accounts')
    .values([
      { id: SYSTEM_ACCOUNTS.MINT, kind: 'MINT', owner_user_id: null, key: 'SYSTEM:MINT' },
      { id: SYSTEM_ACCOUNTS.ESCROW, kind: 'ESCROW', owner_user_id: null, key: 'SYSTEM:ESCROW' },
      { id: SYSTEM_ACCOUNTS.HOUSE, kind: 'HOUSE', owner_user_id: null, key: 'SYSTEM:HOUSE' },
    ])
    .execute();
  // Balances rows are created by the accounts_get_a_balance trigger.
}

let counter = 0;
export function uniqueEmail(): string {
  counter += 1;
  return `player-${process.pid}-${counter}-${Date.now()}@example.test`;
}
