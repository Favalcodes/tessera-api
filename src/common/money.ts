/**
 * Money — integer minor units, enforced by the type system.
 *
 * ADR-005: floats never touch a balance. One credit is 100 minor units, every
 * amount in the system is a whole number of those, and `Money` is branded so a
 * bare `number` cannot be passed where an amount is expected. That turns the
 * entire class of "someone multiplied a balance by a float" bugs into compile
 * errors rather than reconciliation mysteries.
 */

declare const moneyBrand: unique symbol;

/** A signed, whole number of minor units. Construct via the `Money` helpers. */
export type Money = number & { readonly [moneyBrand]: 'Money' };

declare const bpBrand: unique symbol;

/**
 * A multiplier in basis points: 1 bp = 1/10,000, so `10_000` is exactly 1.00x
 * and `34_700` is 3.47x. Integers again, for the same reason.
 */
export type BasisPoints = number & { readonly [bpBrand]: 'BasisPoints' };

export const MINOR_UNITS_PER_CREDIT = 100;
export const BASIS_POINTS_ONE = 10_000;

export class MoneyError extends Error {}

function assertSafeInteger(value: number, label: string): void {
  if (!Number.isInteger(value)) {
    throw new MoneyError(`${label} must be a whole number of minor units, got ${value}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`${label} exceeds the safe integer range: ${value}`);
  }
}

export const Money = {
  zero: 0 as Money,

  /** Build from minor units — the canonical constructor. */
  fromMinor(value: number): Money {
    assertSafeInteger(value, 'amount');
    return value as Money;
  },

  /**
   * Build from whole/fractional credits, e.g. `1000.50` -> 100050 minor units.
   * Rejects anything with sub-minor-unit precision rather than rounding it away
   * silently: if a caller has 0.005 credits, that is a bug upstream, not a
   * rounding decision for this function to make.
   */
  fromCredits(credits: number): Money {
    const minor = Math.round(credits * MINOR_UNITS_PER_CREDIT);
    if (Math.abs(credits * MINOR_UNITS_PER_CREDIT - minor) > Number.EPSILON * 1e6) {
      throw new MoneyError(`${credits} credits is finer than one minor unit`);
    }
    assertSafeInteger(minor, 'amount');
    return minor as Money;
  },

  add(a: Money, b: Money): Money {
    const sum = a + b;
    assertSafeInteger(sum, 'sum');
    return sum as Money;
  },

  sub(a: Money, b: Money): Money {
    const diff = a - b;
    assertSafeInteger(diff, 'difference');
    return diff as Money;
  },

  negate(a: Money): Money {
    // Subtraction rather than unary minus: the brand makes `-a` an unsafe
    // operation to the type checker, and widening it back is the clearer fix.
    return (0 - (a as number)) as Money;
  },

  /**
   * Apply a multiplier, rounding DOWN — always in the house's favour.
   *
   * The rounding direction is a deliberate, documented choice rather than an
   * accident of whichever operator was reached for. Rounding toward the player
   * on every payout would leak fractions of a credit out of the house account
   * indefinitely; rounding down cannot. The intermediate product is computed in
   * BigInt because `stake * multiplier` can exceed 2^53 for large stakes at high
   * multipliers even though the result comfortably fits.
   */
  applyMultiplier(amount: Money, multiplier: BasisPoints): Money {
    if (amount < 0) {
      throw new MoneyError('applyMultiplier expects a non-negative amount');
    }
    if (multiplier < 0) {
      throw new MoneyError('multiplier may not be negative');
    }
    const product = (BigInt(amount) * BigInt(multiplier)) / BigInt(BASIS_POINTS_ONE);
    const result = Number(product);
    assertSafeInteger(result, 'payout');
    return result as Money;
  },

  isPositive(a: Money): boolean {
    return a > 0;
  },

  /** Render for humans and for API responses: `100050` -> `"1000.50"`. */
  format(a: Money): string {
    const negative = a < 0;
    const abs = Math.abs(a);
    const whole = Math.floor(abs / MINOR_UNITS_PER_CREDIT);
    const frac = abs % MINOR_UNITS_PER_CREDIT;
    return `${negative ? '-' : ''}${whole}.${String(frac).padStart(2, '0')}`;
  },
};

export const BasisPoints = {
  one: BASIS_POINTS_ONE as BasisPoints,

  fromMultiplier(multiplier: number): BasisPoints {
    const bp = Math.round(multiplier * BASIS_POINTS_ONE);
    assertSafeInteger(bp, 'multiplier');
    if (bp < 0) throw new MoneyError('multiplier may not be negative');
    return bp as BasisPoints;
  },

  fromRaw(bp: number): BasisPoints {
    assertSafeInteger(bp, 'multiplier');
    return bp as BasisPoints;
  },

  /** `34_700` -> `"3.47"`. */
  format(bp: BasisPoints): string {
    return (bp / BASIS_POINTS_ONE).toFixed(2);
  },
};
