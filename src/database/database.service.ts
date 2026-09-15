import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Kysely } from 'kysely';
import type { DB } from './schema';

export const KYSELY = Symbol('KYSELY');

/**
 * Thin wrapper so the rest of the app injects a class rather than a symbol, and
 * so pool teardown is tied to the Nest lifecycle (tests that leak a pool hang).
 */
@Injectable()
export class DatabaseService implements OnModuleDestroy {
  constructor(@Inject(KYSELY) readonly db: Kysely<DB>) {}

  async onModuleDestroy(): Promise<void> {
    await this.db.destroy();
  }
}
