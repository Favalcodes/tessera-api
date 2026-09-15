import { Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  type OnGatewayConnection,
  type OnGatewayInit,
} from '@nestjs/websockets';
import {
  multiplierAtElapsed,
  ROUND_CHANNEL,
  ServerEvent,
  userChannel,
  BASIS_POINTS_ONE,
  type ClientToServerEvents,
  type RoundView,
  type ServerToClientEvents,
} from '@tessera/contracts';
import type { Server, Socket } from 'socket.io';

/** What we attach to a connected socket. */
interface SocketData {
  userId?: string;
}

/** Typed from the shared contract, so a renamed event fails to compile here. */
type LiveSocket = Socket<ClientToServerEvents, ServerToClientEvents, never, SocketData>;
type LiveServer = Server<ClientToServerEvents, ServerToClientEvents, never, SocketData>;
import type { Subscription } from 'rxjs';
import { Money } from '../common/value-objects/money';
import { corsOrigins, type Env } from '../config/env.validation';
import { TokensService } from '../auth/tokens.service';
import { RoundEventBusService } from './events/round-event-bus.service';
import type { RoundDomainEvent } from './events/round-events';
import { NoActiveRoundError } from './exceptions/rounds.exceptions';
import { RoundsService } from './rounds.service';

/**
 * The only place in the codebase that knows a WebSocket exists.
 *
 * It subscribes to the domain event bus and translates to the wire contract.
 * The engine and the betting service publish events without any knowledge of
 * this class, which is what lets the whole of Phase 2 be tested without a socket
 * client anywhere near it.
 */
@WebSocketGateway({
  namespace: '/live',
  cors: { origin: true, credentials: true },
})
export class RoundsGateway implements OnGatewayInit, OnGatewayConnection, OnModuleDestroy {
  private readonly logger = new Logger(RoundsGateway.name);

  @WebSocketServer()
  private server!: LiveServer;

  private subscription: Subscription | null = null;
  private syncTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly rounds: RoundsService,
    private readonly events: RoundEventBusService,
    private readonly tokens: TokensService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  afterInit(server: LiveServer): void {
    const allowed = corsOrigins(this.config.get('CORS_ORIGINS', { infer: true }));
    server.engine?.on?.('initial_headers', () => undefined);

    this.subscription = this.events.events$.subscribe((event) => {
      void this.dispatch(event);
    });

    // A single low-frequency heartbeat for everyone, rather than a per-client
    // stream. Clients compute the climbing multiplier themselves from the
    // round's `startedAt`; this only corrects drift and proves liveness.
    this.syncTimer = setInterval(() => void this.broadcastSync(), 2_000);

    this.logger.log(`Live gateway ready on /live (origins: ${allowed.join(', ') || 'any'})`);
  }

  /**
   * Authentication is optional.
   *
   * Watching a round is public — a visitor should see the game without an
   * account, because a demo nobody can look at is a poor demo. A token only adds
   * the personal room, where balance and settlement events go. Anything that
   * moves money stays on HTTP behind a guard.
   */
  handleConnection(client: LiveSocket): void {
    void client.join(ROUND_CHANNEL);

    const token =
      (typeof client.handshake.auth?.token === 'string' ? client.handshake.auth.token : null) ??
      client.handshake.headers.authorization?.replace(/^Bearer /, '') ??
      null;

    if (token) {
      try {
        const payload = this.tokens.verifyAccessToken(token);
        void client.join(userChannel(payload.sub));
        client.data.userId = payload.sub;
      } catch {
        // An expired token is not a reason to refuse the connection; the client
        // simply watches anonymously until it refreshes and reconnects.
        this.logger.debug('Socket presented an invalid token; continuing unauthenticated');
      }
    }

    // Every connection is answered with full round state rather than a delta, so
    // a client that just joined, or reconnected after four rounds asleep, lands
    // on the current one with nothing to reconstruct.
    void this.sendCurrentState(client);
  }

  @SubscribeMessage('ping')
  handlePing(@MessageBody() clientSentAt: number, @ConnectedSocket() _client: LiveSocket): number {
    // Round-trip probe. The client halves the round trip to estimate one-way
    // latency and derives its offset from the server clock, so a machine whose
    // clock is minutes out still renders the right multiplier.
    void clientSentAt;
    return Date.now();
  }

  private async sendCurrentState(target: LiveSocket): Promise<void> {
    try {
      const round = await this.rounds.getCurrentRound();
      target.emit(ServerEvent.ROUND_STATE, this.statePayload(round));
    } catch (error) {
      if (error instanceof NoActiveRoundError) return; // between rounds; nothing to send
      this.logger.error(`Could not send initial state: ${String(error)}`);
    }
  }

  private async dispatch(event: RoundDomainEvent): Promise<void> {
    try {
      switch (event.type) {
        case 'round.state': {
          const round = await this.rounds.getRound(event.roundId);
          this.server.to(ROUND_CHANNEL).emit(ServerEvent.ROUND_STATE, this.statePayload(round));
          return;
        }

        case 'bet.placed':
          this.server.to(ROUND_CHANNEL).emit(ServerEvent.BET_PLACED, {
            serverTime: new Date().toISOString(),
            betId: event.betId,
            roundId: event.roundId,
            displayName: event.displayName,
            stakeMinor: event.stakeMinor,
            stake: Money.format(Money.fromMinor(event.stakeMinor)),
          });
          return;

        case 'bet.cashed_out':
          this.server.to(ROUND_CHANNEL).emit(ServerEvent.BET_CASHED_OUT, {
            serverTime: new Date().toISOString(),
            betId: event.betId,
            roundId: event.roundId,
            displayName: event.displayName,
            stakeMinor: event.stakeMinor,
            stake: Money.format(Money.fromMinor(event.stakeMinor)),
            cashoutMultiplierBp: event.cashoutMultiplierBp,
            payoutMinor: event.payoutMinor,
            payout: Money.format(Money.fromMinor(event.payoutMinor)),
          });
          return;

        case 'wallet.updated':
          this.server.to(userChannel(event.userId)).emit(ServerEvent.WALLET_UPDATED, {
            serverTime: new Date().toISOString(),
            balanceMinor: event.balanceMinor,
            balance: Money.format(Money.fromMinor(event.balanceMinor)),
          });
          return;

        case 'bet.settled':
          this.server.to(userChannel(event.userId)).emit(ServerEvent.BET_SETTLED, {
            serverTime: new Date().toISOString(),
            bet: event.bet,
          });
          return;
      }
    } catch (error) {
      this.logger.error(`Failed to dispatch ${event.type}: ${String(error)}`);
    }
  }

  private async broadcastSync(): Promise<void> {
    try {
      const round = await this.rounds.getCurrentRound();
      if (round.status !== 'FLYING' || !round.startedAt) return;

      this.server.to(ROUND_CHANNEL).emit(ServerEvent.ROUND_SYNC, {
        serverTime: new Date().toISOString(),
        roundId: round.id,
        multiplierBp: this.multiplierFor(round),
      });
    } catch (error) {
      if (error instanceof NoActiveRoundError) return;
      this.logger.error(`Sync broadcast failed: ${String(error)}`);
    }
  }

  private statePayload(round: RoundView) {
    return {
      serverTime: new Date().toISOString(),
      round,
      multiplierBp: this.multiplierFor(round),
    };
  }

  private multiplierFor(round: RoundView): number {
    if (round.status === 'CRASHED' || round.status === 'SETTLED') {
      return round.crashPointBp ?? BASIS_POINTS_ONE;
    }
    if (round.status !== 'FLYING' || !round.startedAt) return BASIS_POINTS_ONE;

    return multiplierAtElapsed(Date.now() - new Date(round.startedAt).getTime());
  }

  onModuleDestroy(): void {
    this.subscription?.unsubscribe();
    if (this.syncTimer) clearInterval(this.syncTimer);
  }
}
