/**
 * Round lifecycle, shared so the client can reason about state without
 * re-deriving the rules.
 *
 *   OPEN ──▶ LOCKED ──▶ FLYING ──▶ CRASHED ──▶ SETTLED
 *    │                     │
 *    │ place a bet         │ cash out
 *    └── allowed here      └── allowed here
 */
export const RoundStatus = {
  /** Accepting bets. */
  OPEN: 'OPEN',
  /** Betting closed; the round has not started climbing yet. */
  LOCKED: 'LOCKED',
  /** In flight. The multiplier is climbing and cash-outs are accepted. */
  FLYING: 'FLYING',
  /** The multiplier hit the crash point. No further cash-outs. */
  CRASHED: 'CRASHED',
  /** Every bet has been resolved and posted to the ledger. */
  SETTLED: 'SETTLED',
} as const;

export type RoundStatus = (typeof RoundStatus)[keyof typeof RoundStatus];

export const BetStatus = {
  /** Placed, still in the round. */
  ACTIVE: 'ACTIVE',
  /** Cashed out before the crash. */
  CASHED_OUT: 'CASHED_OUT',
  /** Still in at the crash. */
  LOST: 'LOST',
  /** The round could not be resolved; the stake was returned. */
  VOIDED: 'VOIDED',
} as const;

export type BetStatus = (typeof BetStatus)[keyof typeof BetStatus];

export interface RoundView {
  id: string;
  status: RoundStatus;
  /** Published before the round starts; the commitment. */
  seedHash: string;
  /** Revealed only once the round has crashed. */
  seedRevealed: string | null;
  /** Revealed only once the round has crashed. */
  crashPointBp: number | null;
  opensAt: string;
  locksAt: string;
  startedAt: string | null;
  crashedAt: string | null;
  /** Server time when this view was produced, for client clock-offset handling. */
  serverTime: string;
}

export interface BetView {
  id: string;
  roundId: string;
  stakeMinor: number;
  stake: string;
  status: BetStatus;
  cashoutMultiplierBp: number | null;
  payoutMinor: number | null;
  payout: string | null;
  createdAt: string;
}

export interface PlaceBetRequest {
  stakeMinor: number;
  idempotencyKey: string;
}

export interface CashOutRequest {
  idempotencyKey: string;
}
