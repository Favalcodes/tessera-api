import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from 'pg';
import type { Env } from '../config/env.validation';

/**
 * Single-writer election for the round engine (ADR-007).
 *
 * Only the process holding this lock runs the tick loop and resolves rounds.
 * Two replicas each running a scheduler would open duplicate rounds and settle
 * bets twice — a bug that never appears in single-instance development and
 * appears immediately anywhere else.
 *
 * A Postgres session-level advisory lock is the right primitive: it is held for
 * as long as the connection lives and is released automatically if the process
 * dies, so a crashed leader does not wedge the system. That is why this holds a
 * dedicated client rather than borrowing from the pool — a pooled connection
 * returns to the pool between queries and would take the lock with it.
 */
@Injectable()
export class LeaderElectionService implements OnModuleDestroy {
  private readonly logger = new Logger(LeaderElectionService.name);

  /** Arbitrary but fixed. Every Tessera process competes for this one key. */
  private static readonly LOCK_KEY = 0x7e55e7a;

  private client: Client | null = null;
  private leader = false;

  constructor(private readonly config: ConfigService<Env, true>) {}

  get isLeader(): boolean {
    return this.leader;
  }

  async tryAcquire(): Promise<boolean> {
    if (this.leader) return true;

    this.client ??= new Client({
      connectionString: this.config.get('DATABASE_URL', { infer: true }),
    });

    if (!this.clientConnected) {
      await this.client.connect();
      this.clientConnected = true;
    }

    const result = await this.client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS acquired',
      [LeaderElectionService.LOCK_KEY],
    );

    this.leader = result.rows[0]?.acquired ?? false;

    if (this.leader) {
      this.logger.log('Acquired the round engine lock; this process is the leader');
    } else {
      this.logger.log('Another process holds the round engine lock; running as a follower');
    }

    return this.leader;
  }

  private clientConnected = false;

  async release(): Promise<void> {
    if (!this.client || !this.clientConnected) return;

    try {
      if (this.leader) {
        await this.client.query('SELECT pg_advisory_unlock($1)', [
          LeaderElectionService.LOCK_KEY,
        ]);
        this.logger.log('Released the round engine lock');
      }
    } finally {
      this.leader = false;
      await this.client.end();
      this.clientConnected = false;
      this.client = null;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.release();
  }
}
