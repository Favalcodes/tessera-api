/**
 * Round lifecycle, shared so the client can reason about state without
 * re-deriving the rules.
 *
 *   OPEN ──▶ LOCKED ──▶ FLYING ──▶ CRASHED ──▶ SETTLED
 *    │                     │
 *    │ place a bet         │ cash out
 *    └── allowed here      └── allowed here
 */
/** Which game a round belongs to. Both run concurrently, one round each. */
export const GameKind = {
  CRASH: 'CRASH',
  ROULETTE: 'ROULETTE',
} as const;

export type GameKind = (typeof GameKind)[keyof typeof GameKind];

export const RoundStatus = {
  /** Accepting bets. */
  OPEN: 'OPEN',
  /** Betting closed; the round has not started climbing yet. */
  LOCKED: 'LOCKED',
  /**
   * The round is running. For crash the multiplier is climbing and cash-outs
   * are accepted; for roulette the ball is in motion and nothing more can be
   * done.
   */
  RUNNING: 'RUNNING',
  /** The outcome is known: crash point reached, or pocket determined. */
  RESOLVED: 'RESOLVED',
  /** Every bet has been resolved and posted to the ledger. */
  SETTLED: 'SETTLED',
  /**
   * The round could not be completed and every stake was returned.
   *
   * Reached when the engine was not running long enough for the round to be
   * resolved on time — players had no opportunity to cash out, so charging them
   * for it would be wrong. A voided round still reveals its seed, so voids can
   * be audited against the outcomes they discarded.
   */
  VOIDED: 'VOIDED',
} as const;

export type RoundStatus = (typeof RoundStatus)[keyof typeof RoundStatus];

export const BetStatus = {
  /** Placed, not yet resolved. */
  ACTIVE: 'ACTIVE',
  /**
   * The bet paid out. Crash: cashed out before the crash, at the multiplier
   * reached. Roulette: the selection came in, at the odds it was accepted at.
   */
  WON: 'WON',
  /** Crash: still in at the crash. Roulette: the selection did not come in. */
  LOST: 'LOST',
  /** The round could not be resolved; the stake was returned. */
  VOIDED: 'VOIDED',
} as const;

export type BetStatus = (typeof BetStatus)[keyof typeof BetStatus];

export interface RoundView {
  id: string;
  game: GameKind;
  status: RoundStatus;
  /** Position in the sequence; also the message the outcome is derived from. */
  nonce: number;
  /** Published before the round starts; the commitment. */
  seedHash: string;
  /** Revealed only once the round has crashed. */
  seedRevealed: string | null;
  /** Crash only. Revealed once the round resolves. */
  crashPointBp: number | null;
  /** Roulette only. Revealed once the round resolves. */
  winningPocket: number | null;
  opensAt: string;
  locksAt: string;
  startedAt: string | null;
  resolvedAt: string | null;
  /** Server time when this view was produced, for client clock-offset handling. */
  serverTime: string;
}

export interface BetView {
  id: string;
  roundId: string;
  game: GameKind;
  /** Roulette only: what was bet on, and the odds it was accepted at. */
  selection: { type: string; value?: number } | null;
  oddsBp: number | null;
  stakeMinor: number;
  stake: string;
  status: BetStatus;
  settledMultiplierBp: number | null;
  payoutMinor: number | null;
  payout: string | null;
  createdAt: string;
}

export interface PlaceBetRequest {
  stakeMinor: number;
  idempotencyKey: string;
  /** Required for roulette, omitted for crash. */
  selection?: { type: string; value?: number };
}

export interface CashOutRequest {
  idempotencyKey: string;
}
