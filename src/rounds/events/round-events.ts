import type { BetView } from '@tessera/contracts';

/**
 * Internal domain events, as they travel between processes.
 *
 * Distinct from the wire contract in `@tessera/contracts`: this is what the
 * engine publishes, that is what a browser receives. Keeping them separate means
 * the engine never has to know a socket exists.
 */

export const ROUND_EVENT_CHANNEL = 'tessera_round_events';

export type RoundDomainEvent =
  /** A round changed lifecycle state. Carries only the id; the gateway reads the row. */
  | { type: 'round.state'; roundId: string }
  | {
      type: 'bet.placed';
      roundId: string;
      betId: string;
      displayName: string;
      stakeMinor: number;
    }
  | {
      type: 'bet.cashed_out';
      roundId: string;
      betId: string;
      displayName: string;
      stakeMinor: number;
      cashoutMultiplierBp: number;
      payoutMinor: number;
    }
  /** A bet reached a final state. Personal to one user. */
  | { type: 'bet.settled'; userId: string; bet: BetView }
  /** A user's balance moved. Personal to one user. */
  | { type: 'wallet.updated'; userId: string; balanceMinor: number };
