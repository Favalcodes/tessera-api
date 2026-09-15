import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sql } from 'kysely';
import { Client } from 'pg';
import { Subject, type Observable } from 'rxjs';
import type { Env } from '../../config/env.validation';
import { DatabaseService } from '../../database/database.service';
import type { Executor } from '../../ledger/ledger.types';
import { ROUND_EVENT_CHANNEL, type RoundDomainEvent } from './round-events';

/**
 * Fan-out across processes, over Postgres `LISTEN`/`NOTIFY`.
 *
 * The round engine runs on one leader (ADR-007) but every instance has clients
 * connected to it, so local events are not enough — a follower would broadcast
 * nothing. The usual answer is a Redis pub/sub adapter. This uses the database
 * already in the stack instead, which the PRD's own warning about adding
 * infrastructure for its own sake argues for: one fewer service to run, deploy,
 * secure and explain.
 *
 * The property that makes it more than a shortcut is that `pg_notify` is
 * **transactional**. A notification queued inside a transaction is delivered only
 * if that transaction commits. So publishing an event alongside the write it
 * describes is atomic: no "bet placed" ever reaches a client for a bet that
 * rolled back, with no outbox table and no reconciliation.
 *
 * What it is not: durable. A client disconnected at the moment of a broadcast
 * has missed it permanently, which is why every reconnect resyncs against full
 * round state rather than replaying a backlog.
 */
@Injectable()
export class RoundEventBusService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RoundEventBusService.name);
  private readonly subject = new Subject<RoundDomainEvent>();

  private listener: Client | null = null;
  private closing = false;

  constructor(
    private readonly database: DatabaseService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Every event reaching this process, whichever instance published it. */
  get events$(): Observable<RoundDomainEvent> {
    return this.subject.asObservable();
  }

  async onModuleInit(): Promise<void> {
    // Listens in tests too. The engine's timer is disabled there, but the
    // NOTIFY path is exactly what the real-time tests need to exercise — a bus
    // that only worked outside tests would be untested where it matters.
    await this.startListening();
  }

  private async startListening(): Promise<void> {
    this.listener = new Client({
      connectionString: this.config.get('DATABASE_URL', { infer: true }),
    });

    this.listener.on('notification', (message) => {
      if (message.channel !== ROUND_EVENT_CHANNEL || !message.payload) return;
      try {
        this.subject.next(JSON.parse(message.payload) as RoundDomainEvent);
      } catch (error) {
        this.logger.error(`Malformed event payload: ${String(error)}`);
      }
    });

    // A dropped listener is silent by nature — no error, just no events — so
    // reconnect rather than waiting for someone to notice the page went quiet.
    this.listener.on('error', (error) => {
      if (this.closing) return;
      this.logger.error(`Event listener lost: ${error.message}; reconnecting`);
      void this.reconnect();
    });

    await this.listener.connect();
    await this.listener.query(`LISTEN ${ROUND_EVENT_CHANNEL}`);
    this.logger.log(`Listening for round events on "${ROUND_EVENT_CHANNEL}"`);
  }

  private async reconnect(): Promise<void> {
    try {
      await this.listener?.end().catch(() => undefined);
      this.listener = null;
      if (this.closing) return;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await this.startListening();
    } catch (error) {
      this.logger.error(`Reconnect failed: ${String(error)}; retrying`);
      if (!this.closing) setTimeout(() => void this.reconnect(), 2_000);
    }
  }

  /**
   * Publish an event.
   *
   * Pass the transaction that performed the write. The notification then commits
   * or rolls back with it, so the event and the fact it describes cannot
   * disagree.
   */
  async publish(event: RoundDomainEvent, executor: Executor = this.database.db): Promise<void> {
    const payload = JSON.stringify(event);

    // NOTIFY payloads are capped at 8000 bytes. Every event here is far smaller,
    // but a silent truncation would be a miserable bug to find.
    if (Buffer.byteLength(payload) > 7_500) {
      this.logger.error(`Refusing to publish an oversized ${event.type} event`);
      return;
    }

    await sql`SELECT pg_notify(${ROUND_EVENT_CHANNEL}, ${payload})`.execute(executor);
  }

  /** Deliver an event to this process only. Used by tests, which do not LISTEN. */
  emitLocal(event: RoundDomainEvent): void {
    this.subject.next(event);
  }

  async onModuleDestroy(): Promise<void> {
    this.closing = true;
    this.subject.complete();
    await this.listener?.end().catch(() => undefined);
  }
}
