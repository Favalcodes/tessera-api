/**
 * Money and multiplier arithmetic, shared verbatim by the API and the client.
 *
 * These are the definitions both sides must agree on exactly. If the client
 * formats or multiplies differently from the server, the number a player reads
 * on screen disagrees with the number the server settles — which is a trust
 * problem, not a cosmetic one.
 */

/** One credit is 100 minor units. Every stored amount is a whole number of these. */
export const MINOR_UNITS_PER_CREDIT = 100;

/** Multipliers are basis points: 10_000 is exactly 1.00x, 34_700 is 3.47x. */
export const BASIS_POINTS_ONE = 10_000;

/** `100050` -> `"1000.50"`. Never uses floating point. */
export function formatMinorUnits(minorUnits: number): string {
  const negative = minorUnits < 0;
  const absolute = Math.abs(minorUnits);
  const whole = Math.floor(absolute / MINOR_UNITS_PER_CREDIT);
  const fraction = absolute % MINOR_UNITS_PER_CREDIT;
  return `${negative ? '-' : ''}${whole}.${String(fraction).padStart(2, '0')}`;
}

/** `34_700` -> `"3.47"`. */
export function formatBasisPoints(basisPoints: number): string {
  return (basisPoints / BASIS_POINTS_ONE).toFixed(2);
}

/** `"1000.50"` or `1000.5` -> `100050`. Throws below minor-unit precision. */
export function creditsToMinorUnits(credits: number): number {
  const minor = Math.round(credits * MINOR_UNITS_PER_CREDIT);
  if (Math.abs(credits * MINOR_UNITS_PER_CREDIT - minor) > Number.EPSILON * 1e6) {
    throw new RangeError(`${credits} credits is finer than one minor unit`);
  }
  return minor;
}

/**
 * Apply a basis-point multiplier to an amount, rounding DOWN.
 *
 * Flooring is deliberate and always favours the house. Rounding toward the
 * player on every payout leaks fractions of a credit out of the house account
 * indefinitely; flooring cannot.
 *
 * The intermediate product is computed in BigInt because `amount * multiplier`
 * can exceed 2^53 for large stakes at high multipliers even when the result
 * comfortably fits in a safe integer.
 */
export function applyBasisPoints(minorUnits: number, basisPoints: number): number {
  if (!Number.isInteger(minorUnits) || !Number.isInteger(basisPoints)) {
    throw new RangeError('applyBasisPoints requires whole numbers');
  }
  if (minorUnits < 0) throw new RangeError('amount may not be negative');
  if (basisPoints < 0) throw new RangeError('multiplier may not be negative');

  const product = (BigInt(minorUnits) * BigInt(basisPoints)) / BigInt(BASIS_POINTS_ONE);
  const result = Number(product);

  if (!Number.isSafeInteger(result)) {
    throw new RangeError(`payout ${product} exceeds the safe integer range`);
  }

  return result;
}
