import type { BetView, RoundView } from './round.types';

/**
 * The WebSocket contract.
 *
 * This is the surface ADR-004 warned about: two repos, one protocol, and
 * nothing but this package stopping them from drifting. Renaming an event or
 * changing a payload here fails the web app's typecheck, which is the point.
 */

/** Channel names. Public state is broadcast; personal events go to one room. */
export const ROUND_CHANNEL = 'rounds';
export const userChannel = (userId: string): string => `user:${userId}`;

export const ServerEvent = {
  /**
   * Full round state. Sent on connect and on every lifecycle transition, rather
   * than a delta — a client that missed an event, or joined mid-round, must not
   * have to reconstruct anything.
   */
  ROUND_STATE: 'round:state',
  /**
   * Low-frequency heartbeat while a round is flying.
   *
   * Deliberately *not* a per-frame multiplier. Pushing the climbing number at
   * 60fps to every viewer is the obvious implementation and the wrong one: it is
   * O(viewers x framerate) messages for information the client can compute
   * itself from `startedAt`. This exists only to correct drift and to prove the
   * connection is alive.
   */
  ROUND_SYNC: 'round:sync',
  /** Someone placed a bet. Public feed. */
  BET_PLACED: 'bet:placed',
  /**
   * Someone's bet paid out. Public feed.
   *
   * Crash fires this the moment a player cashes out, which is a live event
   * others react to. Roulette fires it at settlement, since there is no earlier
   * moment for it to happen.
   */
  BET_WON: 'bet:won',
  /** Your balance changed. Personal room only. */
  WALLET_UPDATED: 'wallet:updated',
  /** One of your bets reached a final state. Personal room only. */
  BET_SETTLED: 'bet:settled',
} as const;

export type ServerEvent = (typeof ServerEvent)[keyof typeof ServerEvent];

/**
 * Every payload carries `serverTime`.
 *
 * The client keeps a running offset between this and its own clock, and renders
 * the multiplier from the corrected time. Without it a viewer whose machine is
 * thirty seconds fast sees a wildly wrong number and cannot be told apart from a
 * viewer with a slow connection.
 */
export interface ServerTimestamped {
  serverTime: string;
}

export interface RoundStatePayload extends ServerTimestamped {
  round: RoundView;
  /** Advisory. Authoritative only for a round that has already concluded. */
  multiplierBp: number;
}

export interface RoundSyncPayload extends ServerTimestamped {
  roundId: string;
  multiplierBp: number;
}

/** A public view of someone else's bet: no user id, no balance. */
export interface PublicBetPayload extends ServerTimestamped {
  betId: string;
  roundId: string;
  game: string;
  displayName: string;
  stakeMinor: number;
  stake: string;
  /** Roulette: what they backed. Crash has nothing to name. */
  selection?: { type: string; value?: number };
  settledMultiplierBp?: number;
  payoutMinor?: number;
  payout?: string;
}

export interface WalletUpdatedPayload extends ServerTimestamped {
  balanceMinor: number;
  balance: string;
}

export interface BetSettledPayload extends ServerTimestamped {
  bet: BetView;
}

/** Server -> client. The map a typed socket client is built from. */
export interface ServerToClientEvents {
  [ServerEvent.ROUND_STATE]: (payload: RoundStatePayload) => void;
  [ServerEvent.ROUND_SYNC]: (payload: RoundSyncPayload) => void;
  [ServerEvent.BET_PLACED]: (payload: PublicBetPayload) => void;
  [ServerEvent.BET_WON]: (payload: PublicBetPayload) => void;
  [ServerEvent.WALLET_UPDATED]: (payload: WalletUpdatedPayload) => void;
  [ServerEvent.BET_SETTLED]: (payload: BetSettledPayload) => void;
}

/**
 * Client -> server: nothing that affects money.
 *
 * Bets and cash-outs stay on HTTP deliberately. They need idempotency keys,
 * precise status codes and retry semantics, and a socket message is a poor place
 * for all three — a dropped connection leaves the client unable to tell whether
 * its bet landed. The socket carries state *outward* only.
 */
export interface ClientToServerEvents {
  /** Round-trip probe for clock offset and latency. */
  ping: (clientSentAt: number, ack: (serverTime: number) => void) => void;
}
