/**
 * How a round's outcome is decided.
 *
 * An interface because Phase 4 replaces the implementation, not the callers.
 * Today a round draws a fresh random seed and publishes its hash (commit /
 * reveal). Phase 4 swaps in a pre-committed hash chain, where every seed is
 * fixed before the first round ever runs and any revealed seed can be hashed
 * forward to a published genesis commitment — a strictly stronger claim, and
 * one the round engine should not have to know about.
 *
 * Whatever generates the seed, the *derivation* of a crash point from it is
 * shared with the client in `@tessera/contracts`, so a player can verify a past
 * round without trusting this code.
 */
export interface RoundOutcome {
  /** Published before betting opens. */
  seedHash: string;
  /** Held back until the round has crashed. */
  seed: string;
  /** Derived deterministically from the seed and the round's nonce. */
  crashPointBp: number;
}

export interface FairnessProvider {
  /** Draw the outcome for the round with this nonce. */
  drawOutcome(nonce: number): Promise<RoundOutcome>;

  /**
   * Recompute an outcome from a revealed seed, so verification runs through the
   * same path as generation rather than a parallel implementation that could
   * drift from it.
   */
  verify(seed: string, nonce: number): { seedHash: string; crashPointBp: number };
}

export const FAIRNESS_PROVIDER = Symbol('FAIRNESS_PROVIDER');
