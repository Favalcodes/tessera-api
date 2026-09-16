import type { GameKind } from './round.types';

/** Every kind of balance-affecting event the ledger records. */
export const TransactionKind = {
  SIGNUP_GRANT: 'SIGNUP_GRANT',
  BET_PLACED: 'BET_PLACED',
  BET_CASHOUT: 'BET_CASHOUT',
  BET_LOST: 'BET_LOST',
  ROUND_VOID_REFUND: 'ROUND_VOID_REFUND',
} as const;

export type TransactionKind = (typeof TransactionKind)[keyof typeof TransactionKind];

export type PostingDirection = 'debit' | 'credit';

export interface BalanceResponse {
  /** Authoritative value, in minor units. */
  balanceMinor: number;
  /** Pre-formatted for display, so both sides cannot format differently. */
  balance: string;
}

/**
 * What a posting was for, in the language of the game.
 *
 * The ledger itself knows nothing about games — it records movements between
 * accounts and nothing else, which is what makes it a ledger. This is resolved
 * by the history endpoint from the bet a posting references, so a player can
 * read their statement without holding round ids in their head.
 */
export interface LedgerEntryContext {
  game: GameKind;
  /** The round's position in the sequence, for cross-referencing. */
  roundNonce: number;
  /** Roulette: what was backed. */
  selection?: { type: string; value?: number };
  /** The multiplier a winning bet settled at. */
  multiplierBp?: number;
}

export interface LedgerEntry {
  id: number;
  transactionId: string;
  kind: string;
  amountMinor: number;
  amount: string;
  direction: PostingDirection;
  referenceType: string | null;
  referenceId: string | null;
  createdAt: string;
  /** Null for postings that are not tied to a bet, such as the opening grant. */
  context: LedgerEntryContext | null;
}

export interface LedgerPage {
  entries: LedgerEntry[];
  /** Pass back as `?cursor=` for the next page; null when exhausted. */
  nextCursor: number | null;
  /** Postings on this account in total, so a page can say where it sits. */
  total: number;
}
