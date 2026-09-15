import {
  applyBasisPoints,
  BASIS_POINTS_ONE,
  creditsToMinorUnits,
  formatBasisPoints,
  formatMinorUnits,
  MINOR_UNITS_PER_CREDIT,
} from '@tessera/contracts';

/**
 * Money — integer minor units, enforced by the type system.
 *
 * The arithmetic itself lives in `@tessera/contracts` so the web client computes
 * identical results; this file adds the branding that makes a bare `number`
 * unusable where an amount is expected. That split matters: the *rules* are
 * shared with the client, the *type safety* is a server-side concern the client
 * does not need.
 *
 * ADR-005: floats never touch a balance.
 */

declare const moneyBrand: unique symbol;

/** A signed, whole number of minor units. Construct via the `Money` helpers. */
export type Money = number & { readonly [moneyBrand]: 'Money' };

declare const bpBrand: unique symbol;

/** A multiplier in basis points: `10_000` is exactly 1.00x, `34_700` is 3.47x. */
export type BasisPoints = number & { readonly [bpBrand]: 'BasisPoints' };

export { BASIS_POINTS_ONE, MINOR_UNITS_PER_CREDIT };

export class MoneyError extends Error {}

function assertSafeInteger(value: number, label: string): void {
  if (!Number.isInteger(value)) {
    throw new MoneyError(`${label} must be a whole number of minor units, got ${value}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`${label} exceeds the safe integer range: ${value}`);
  }
}

/** Re-throw a shared-arithmetic RangeError as the domain error type. */
function asMoneyError<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    throw new MoneyError(error instanceof Error ? error.message : String(error));
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
   * Build from credits, e.g. `1000.50` -> 100050 minor units. Rejects anything
   * finer than a minor unit rather than rounding it away silently: if a caller
   * has 0.005 credits that is a bug upstream, not a rounding decision for this
   * function to make.
   */
  fromCredits(credits: number): Money {
    return asMoneyError(() => creditsToMinorUnits(credits)) as Money;
  },

  add(a: Money, b: Money): Money {
    const sum = a + b;
    assertSafeInteger(sum, 'sum');
    return sum as Money;
  },

  sub(a: Money, b: Money): Money {
    const difference = a - b;
    assertSafeInteger(difference, 'difference');
    return difference as Money;
  },

  negate(a: Money): Money {
    // Subtraction rather than unary minus: the brand makes `-a` an unsafe
    // operation to the type checker, and widening it back is the clearer fix.
    return (0 - (a as number)) as Money;
  },

  /**
   * Apply a multiplier, rounding DOWN — always in the house's favour.
   * Delegates to the shared implementation so the client's displayed payout and
   * the server's settled payout cannot disagree.
   */
  applyMultiplier(amount: Money, multiplier: BasisPoints): Money {
    return asMoneyError(() => applyBasisPoints(amount, multiplier)) as Money;
  },

  isPositive(a: Money): boolean {
    return a > 0;
  },

  /** `100050` -> `"1000.50"`. */
  format(a: Money): string {
    return formatMinorUnits(a);
  },
};

export const BasisPoints = {
  one: BASIS_POINTS_ONE as BasisPoints,

  fromMultiplier(multiplier: number): BasisPoints {
    const basisPoints = Math.round(multiplier * BASIS_POINTS_ONE);
    assertSafeInteger(basisPoints, 'multiplier');
    if (basisPoints < 0) throw new MoneyError('multiplier may not be negative');
    return basisPoints as BasisPoints;
  },

  fromRaw(basisPoints: number): BasisPoints {
    assertSafeInteger(basisPoints, 'multiplier');
    return basisPoints as BasisPoints;
  },

  /** `34_700` -> `"3.47"`. */
  format(basisPoints: BasisPoints): string {
    return formatBasisPoints(basisPoints);
  },
};
