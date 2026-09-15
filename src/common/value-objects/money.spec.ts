import { BasisPoints, Money, MoneyError } from './money';

describe('Money', () => {
  it('rejects fractional minor units', () => {
    expect(() => Money.fromMinor(10.5)).toThrow(MoneyError);
  });

  it('rejects amounts finer than one minor unit', () => {
    expect(() => Money.fromCredits(1.005)).toThrow(MoneyError);
  });

  it('converts credits to minor units', () => {
    expect(Money.fromCredits(1000)).toBe(100_000);
    expect(Money.fromCredits(10.5)).toBe(1_050);
  });

  it('formats minor units for display', () => {
    expect(Money.format(Money.fromMinor(100_050))).toBe('1000.50');
    expect(Money.format(Money.fromMinor(5))).toBe('0.05');
    expect(Money.format(Money.fromMinor(-2_500))).toBe('-25.00');
  });

  describe('applyMultiplier', () => {
    it('is exact at 1.00x', () => {
      const stake = Money.fromMinor(1_000);
      expect(Money.applyMultiplier(stake, BasisPoints.fromMultiplier(1))).toBe(1_000);
    });

    it('computes a typical payout', () => {
      const stake = Money.fromMinor(10_000); // 100.00
      expect(Money.applyMultiplier(stake, BasisPoints.fromMultiplier(3.47))).toBe(34_700);
    });

    it('rounds DOWN, in the house favour, never up', () => {
      // 333 minor units at 1.015x is 337.995 -> must floor to 337, not 338.
      const stake = Money.fromMinor(333);
      expect(Money.applyMultiplier(stake, BasisPoints.fromMultiplier(1.015))).toBe(337);
    });

    it('never leaks a fraction of a unit to the player across many payouts', () => {
      // The whole point of flooring: repeated payouts must not drift upward.
      const stake = Money.fromMinor(101);
      const multiplier = BasisPoints.fromMultiplier(1.005); // 101.505 -> 101
      let total = 0;
      for (let i = 0; i < 1_000; i += 1) {
        total += Money.applyMultiplier(stake, multiplier);
      }
      expect(total).toBe(101_000);
      expect(total).toBeLessThan(101.505 * 1_000);
    });

    it('stays exact for large stakes where float multiplication would not', () => {
      const stake = Money.fromMinor(9_007_199_254_740); // near the safe-integer edge
      const result = Money.applyMultiplier(stake, BasisPoints.fromMultiplier(1.0001));
      expect(Number.isSafeInteger(result)).toBe(true);
    });

    it('refuses a negative multiplier', () => {
      expect(() => Money.applyMultiplier(Money.fromMinor(100), BasisPoints.fromRaw(-1))).toThrow(
        MoneyError,
      );
    });
  });

  describe('BasisPoints', () => {
    it('treats 10,000bp as exactly 1.00x', () => {
      expect(BasisPoints.one).toBe(10_000);
      expect(BasisPoints.format(BasisPoints.fromMultiplier(3.47))).toBe('3.47');
    });
  });
});
