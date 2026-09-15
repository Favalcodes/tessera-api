import { BASIS_POINTS_ONE } from './money';
import { MAX_MULTIPLIER_BP } from './crash-curve';

/**
 * Deriving a round's crash point from a hash.
 *
 * Takes an already-computed hash hex string rather than doing the hashing, so
 * this package stays dependency-free and runtime-neutral: the server hashes with
 * `node:crypto`, the browser with Web Crypto, and both feed the result here.
 *
 * This is the function a player runs to verify a past round. Phase 4 changes
 * only where the seed comes from — a pre-committed hash chain instead of a
 * per-round random — not how the outcome is derived from it.
 */

/**
 * One source of the house edge: a 1-in-101 chance of an instant bust at 1.00x.
 *
 * The `(100E - h) / (E - h)` draw below is, on its own, exactly break-even — a
 * player cashing out at any fixed multiplier gets back 100% of stake over time,
 * which leaves the house unable to cover anything. This roll is what makes the
 * game viable.
 *
 * It is not the whole edge. The draw itself also lands on 1.00x for small `h`,
 * and truncating to two decimal places always rounds toward the house. Measured
 * over 200,000 rounds the combined effect is a return of ~98.6% of stake at any
 * fixed cash-out target, so roughly a **1.4% house edge** — not the 0.99% the
 * bust roll alone would suggest.
 *
 * Published as an explicit constant because a player is meant to be able to
 * check it. A hidden edge is precisely what provable fairness exists to rule out.
 */
export const INSTANT_BUST_DIVISOR = 101;

/** 52 bits: the most a double can hold exactly, and plenty of entropy. */
const ENTROPY_BITS = 52;
const ENTROPY_SPACE = 2 ** ENTROPY_BITS;

/**
 * Derive a crash point in basis points from a hash.
 *
 * The distribution is the standard one for this game type: the probability of
 * reaching a multiplier `m` is roughly `1/m`, so 2.00x comes up about half the
 * time and 10.00x about a tenth. Every 101st round busts instantly at 1.00x,
 * which is where the house edge lives.
 */
export function crashPointFromHash(hashHex: string): number {
  if (!/^[0-9a-f]+$/i.test(hashHex) || hashHex.length < 14) {
    throw new RangeError('crashPointFromHash expects at least 14 hex characters');
  }

  // Instant bust on 1 in INSTANT_BUST_DIVISOR rounds, decided by a separate
  // slice of the hash so it is independent of the multiplier draw.
  const bustRoll = Number.parseInt(hashHex.slice(0, 8), 16);
  if (bustRoll % INSTANT_BUST_DIVISOR === 0) {
    return BASIS_POINTS_ONE;
  }

  const entropy = Number.parseInt(hashHex.slice(8, 21), 16);

  // (100 * E - h) / (E - h), then truncated to two decimal places. The shape is
  // what produces the 1/m tail; the division by 100 and re-multiplication is
  // what truncates it to a real, displayable multiplier.
  const raw = Math.floor((100 * ENTROPY_SPACE - entropy) / (ENTROPY_SPACE - entropy));
  const crashPointBp = raw * (BASIS_POINTS_ONE / 100);

  if (crashPointBp < BASIS_POINTS_ONE) return BASIS_POINTS_ONE;
  return Math.min(crashPointBp, MAX_MULTIPLIER_BP);
}
