import type { BetView } from '@tessera/contracts';

/**
 * Internal domain events, as they travel between processes.
 *
 * Distinct from the wire contract in `@tessera/contracts`: this is what the
 * engine and the betting service publish, that is what a browser receives.
 * Keeping them separate means neither ever has to know a socket exists.
 */

export const ROUND_EVENT_CHANNEL = 'tessera_round_events';

export interface PublicSelection {
  type: string;
  value?: number;
}

export type RoundDomainEvent =
  /** A round changed lifecycle state. Carries only the id; the gateway reads the row. */
  | { type: 'round.state'; roundId: string }
  | {
      type: 'bet.placed';
      roundId: string;
      game: string;
      betId: string;
      displayName: string;
      stakeMinor: number;
      selection?: PublicSelection;
    }
  /**
   * A bet paid out. Crash publishes this the moment a player cashes out;
   * roulette at settlement, since there is no earlier moment for it to happen.
   */
  | {
      type: 'bet.won';
      roundId: string;
      game: string;
      betId: string;
      displayName: string;
      stakeMinor: number;
      selection?: PublicSelection;
      settledMultiplierBp: number;
      payoutMinor: number;
    }
  /** A bet reached a final state. Personal to one user. */
  | { type: 'bet.settled'; userId: string; bet: BetView }
  /** A user's balance moved. Personal to one user. */
  | { type: 'wallet.updated'; userId: string; balanceMinor: number };
