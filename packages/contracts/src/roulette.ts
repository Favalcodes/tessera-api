import { BASIS_POINTS_ONE } from './money';

/**
 * European roulette: 37 pockets, single zero.
 *
 * Every rule lives here rather than on the server, so a client can price a bet
 * and check a settlement without asking — the same reason the crash curve is
 * shared. Nothing in this file has side effects or needs crypto.
 *
 * The house edge is the zero, and nothing else. Every bet below pays true odds
 * against 36 pockets while the wheel has 37, which is exactly 1/37 = 2.70% on
 * every bet type. There is no bet on this table that is better or worse value
 * than another, which is worth stating because players routinely assume
 * otherwise.
 */

export const POCKET_COUNT = 37;

export const RED_POCKETS: readonly number[] = [
  1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36,
];

export const BLACK_POCKETS: readonly number[] = [
  2, 4, 6, 8, 10, 11, 13, 15, 17, 20, 22, 24, 26, 28, 29, 31, 33, 35,
];

export type PocketColour = 'red' | 'black' | 'green';

export function pocketColour(pocket: number): PocketColour {
  if (pocket === 0) return 'green';
  return RED_POCKETS.includes(pocket) ? 'red' : 'black';
}

export const RouletteBetType = {
  /** One number, including zero. */
  STRAIGHT: 'STRAIGHT',
  RED: 'RED',
  BLACK: 'BLACK',
  ODD: 'ODD',
  EVEN: 'EVEN',
  /** 1–18. */
  LOW: 'LOW',
  /** 19–36. */
  HIGH: 'HIGH',
  /** 1–12, 13–24 or 25–36; value is 1, 2 or 3. */
  DOZEN: 'DOZEN',
  /** Every third number from 1, 2 or 3; value is 1, 2 or 3. */
  COLUMN: 'COLUMN',
} as const;

export type RouletteBetType = (typeof RouletteBetType)[keyof typeof RouletteBetType];

/**
 * Total return multipliers, in basis points.
 *
 * Total return, not profit: a straight-up win hands back 36x the stake, of which
 * 35x is profit. Same units as a crash cash-out, so one payout function serves
 * both games.
 */
export const ROULETTE_ODDS_BP: Record<RouletteBetType, number> = {
  STRAIGHT: 36 * BASIS_POINTS_ONE,
  RED: 2 * BASIS_POINTS_ONE,
  BLACK: 2 * BASIS_POINTS_ONE,
  ODD: 2 * BASIS_POINTS_ONE,
  EVEN: 2 * BASIS_POINTS_ONE,
  LOW: 2 * BASIS_POINTS_ONE,
  HIGH: 2 * BASIS_POINTS_ONE,
  DOZEN: 3 * BASIS_POINTS_ONE,
  COLUMN: 3 * BASIS_POINTS_ONE,
};

export interface RouletteSelection {
  type: RouletteBetType;
  /** Required for STRAIGHT (0–36), DOZEN (1–3) and COLUMN (1–3). */
  value?: number;
}

export class RouletteSelectionError extends Error {}

/** Reject a malformed selection before it can be priced or stored. */
export function assertValidSelection(selection: RouletteSelection): void {
  const { type, value } = selection;

  if (!(type in ROULETTE_ODDS_BP)) {
    throw new RouletteSelectionError(`Unknown bet type: ${String(type)}`);
  }

  const needsValue = type === 'STRAIGHT' || type === 'DOZEN' || type === 'COLUMN';

  if (!needsValue) {
    if (value !== undefined) {
      throw new RouletteSelectionError(`${type} does not take a number`);
    }
    return;
  }

  if (value === undefined || !Number.isInteger(value)) {
    throw new RouletteSelectionError(`${type} requires a whole number`);
  }

  if (type === 'STRAIGHT' && (value < 0 || value > 36)) {
    throw new RouletteSelectionError('A straight-up bet must name a pocket from 0 to 36');
  }

  if ((type === 'DOZEN' || type === 'COLUMN') && (value < 1 || value > 3)) {
    throw new RouletteSelectionError(`${type} must be 1, 2 or 3`);
  }
}

export function oddsForSelection(selection: RouletteSelection): number {
  assertValidSelection(selection);
  return ROULETTE_ODDS_BP[selection.type];
}

/**
 * Does this selection win on this pocket?
 *
 * Zero is handled by omission rather than by a special case: it is neither red
 * nor black, neither odd nor even, and in no dozen or column, so every outside
 * bet loses on it naturally. Only a straight-up bet on 0 wins.
 */
export function selectionWins(selection: RouletteSelection, pocket: number): boolean {
  assertValidSelection(selection);

  if (!Number.isInteger(pocket) || pocket < 0 || pocket > 36) {
    throw new RouletteSelectionError(`Pocket ${pocket} is not on the wheel`);
  }

  switch (selection.type) {
    case 'STRAIGHT':
      return pocket === selection.value;
    case 'RED':
      return pocketColour(pocket) === 'red';
    case 'BLACK':
      return pocketColour(pocket) === 'black';
    case 'ODD':
      return pocket !== 0 && pocket % 2 === 1;
    case 'EVEN':
      return pocket !== 0 && pocket % 2 === 0;
    case 'LOW':
      return pocket >= 1 && pocket <= 18;
    case 'HIGH':
      return pocket >= 19 && pocket <= 36;
    case 'DOZEN':
      return pocket !== 0 && Math.ceil(pocket / 12) === selection.value;
    case 'COLUMN':
      return pocket !== 0 && ((pocket - 1) % 3) + 1 === selection.value;
  }
}

/** What a settled bet is worth: the total return multiplier, or zero if it lost. */
export function settleSelection(selection: RouletteSelection, pocket: number): number {
  return selectionWins(selection, pocket) ? oddsForSelection(selection) : 0;
}

/**
 * The winning pocket for a round, from its outcome hash.
 *
 * 52 bits reduced modulo 37. The modulo bias is about 37 / 2^52 — one part in a
 * hundred trillion — which is far below anything observable and well inside the
 * precision a double holds exactly.
 */
export function roulettePocketFromHash(hashHex: string): number {
  if (!/^[0-9a-f]+$/i.test(hashHex) || hashHex.length < 13) {
    throw new RouletteSelectionError('roulettePocketFromHash expects at least 13 hex characters');
  }
  return Number.parseInt(hashHex.slice(0, 13), 16) % POCKET_COUNT;
}

export function describeSelection(selection: RouletteSelection): string {
  switch (selection.type) {
    case 'STRAIGHT':
      return `Straight ${selection.value}`;
    case 'DOZEN':
      return ['1st dozen', '2nd dozen', '3rd dozen'][(selection.value ?? 1) - 1] ?? 'Dozen';
    case 'COLUMN':
      return `Column ${selection.value}`;
    case 'LOW':
      return '1–18';
    case 'HIGH':
      return '19–36';
    default:
      return selection.type.charAt(0) + selection.type.slice(1).toLowerCase();
  }
}
