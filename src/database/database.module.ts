import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool, types as pgTypes } from 'pg';
import type { Env } from '../config/env.validation';
import { DatabaseService, KYSELY } from './database.service';
import type { DB } from './database.types';

/**
 * Postgres returns BIGINT as a string, because a bigint can exceed what a JS
 * number holds exactly. Every bigint in this schema is a minor-unit amount or a
 * row id, all far inside the safe range, so parsing to a number keeps the
 * arithmetic ergonomic — but the parser refuses rather than silently truncating
 * if a value ever does escape that range. A wrong balance must be a crash, not a
 * rounding artefact nobody notices.
 */
pgTypes.setTypeParser(pgTypes.builtins.INT8, (value: string) => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`BIGINT ${value} exceeds the safe integer range and cannot be read as a number`);
  }
  return parsed;
});

@Global()
@Module({
  providers: [
    {
      provide: KYSELY,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): Kysely<DB> => {
        const pool = new Pool({
          connectionString: config.get('DATABASE_URL', { infer: true }),
          max: config.get('DATABASE_POOL_MAX', { infer: true }),
          // Fail fast rather than queueing behind an unreachable database.
          connectionTimeoutMillis: 5_000,
          idleTimeoutMillis: 30_000,
        });

        return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
      },
    },
    DatabaseService,
  ],
  exports: [DatabaseService, KYSELY],
})
export class DatabaseModule {}
