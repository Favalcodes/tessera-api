import { BASIS_POINTS_ONE } from './money';

/**
 * The crash curve — how the multiplier climbs while a round is in flight.
 *
 * Defined here rather than in the API because both sides evaluate it: the server
 * to settle a cash-out, the client to render the climbing number. A client that
 * computed a slightly different curve would show a player a multiplier the server
 * will not pay, which is a trust problem rather than a cosmetic one.
 *
 * Deliberately integer-only. `Math.exp` and `Math.pow` are not guaranteed to be
 * bit-identical across JavaScript engines, and "the number on screen disagrees
 * with the payout" is exactly the class of bug that would produce. The closed
 * form below is exact BigInt arithmetic with a single floor, so every engine
 * agrees by construction.
 */

/** The multiplier advances in discrete 100ms ticks. */
export const TICK_MS = 100;

/** Growth per tick: 1.01x, expressed as a ratio so no float is involved. */
export const GROWTH_NUMERATOR = 101n;
export const GROWTH_DENOMINATOR = 100n;

/**
 * Rounds are capped so one cannot run forever. 1.01^694 is a little over 1000x;
 * a round reaching the cap crashes there regardless of its drawn crash point.
 */
export const MAX_TICKS = 694;

/**
 * Exact multiplier at a given tick, in basis points.
 *
 * `floor(10_000 * 101^n / 100^n)` — one floor at the end rather than one per
 * tick, so the result is the true curve truncated, not an accumulation of 694
 * separate rounding errors.
 */
export function multiplierAtTick(tick: number): number {
  if (!Number.isInteger(tick) || tick < 0) {
    throw new RangeError(`tick must be a non-negative integer, got ${tick}`);
  }

  const cappedTick = Math.min(tick, MAX_TICKS);
  const exponent = BigInt(cappedTick);

  const scaled =
    (BigInt(BASIS_POINTS_ONE) * GROWTH_NUMERATOR ** exponent) / GROWTH_DENOMINATOR ** exponent;

  return Number(scaled);
}

/** Whole ticks elapsed. Partial ticks do not count — the multiplier steps. */
export function tickAtElapsed(elapsedMs: number): number {
  if (elapsedMs < 0) return 0;
  return Math.floor(elapsedMs / TICK_MS);
}

/**
 * The multiplier a round is showing `elapsedMs` after it started.
 *
 * This is the function the server uses to price a cash-out, from its own clock
 * and its own record of `started_at`. A client may call it too, but only to
 * render — it is never trusted as an input (ADR-006).
 */
export function multiplierAtElapsed(elapsedMs: number): number {
  return multiplierAtTick(tickAtElapsed(elapsedMs));
}

/** Milliseconds from round start until the curve first reaches `multiplierBp`. */
export function elapsedAtMultiplier(multiplierBp: number): number {
  if (multiplierBp <= BASIS_POINTS_ONE) return 0;

  // The curve is monotonic, so a binary search over ticks is exact and avoids
  // introducing a logarithm — which would reintroduce the float determinism
  // problem this module exists to avoid.
  let low = 0;
  let high = MAX_TICKS;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (multiplierAtTick(mid) >= multiplierBp) {
      high = mid;
    } else {
      low = mid + 1;
    }
  }

  return low * TICK_MS;
}

/** The highest multiplier any round can reach, in basis points. */
export const MAX_MULTIPLIER_BP = multiplierAtTick(MAX_TICKS);
