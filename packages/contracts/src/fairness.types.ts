import type { GameKind } from './round.types';

/** Everything a player needs to check a round for themselves. */
export interface FairnessProof {
  roundId: string;
  /** Which game's outcome this proof covers; they derive differently. */
  game: GameKind;
  /** The round's position in the sequence; also the HMAC message. */
  nonce: number;

  /** Published before betting opened. */
  seedHash: string;
  /** Revealed once the round ended; null while it is still running. */
  seedRevealed: string | null;
  /** Crash only. The outcome in basis points; null until the round ends. */
  crashPointBp: number | null;
  /** Roulette only. The pocket; null until the round ends. */
  winningPocket: number | null;

  /** `s[0]`, published before this chain's first round ever opened. */
  genesisHash: string;
  /** This round's position in the chain. */
  chainIndex: number;
  /** How many rounds the chain covers. */
  chainLength: number;

  /** How to reproduce the outcome, stated rather than assumed. */
  algorithm: {
    seedHash: string;
    outcomeHash: string;
    crashPoint: string;
    chain: string;
  };
}
