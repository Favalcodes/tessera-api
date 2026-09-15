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
}

export interface LedgerPage {
  entries: LedgerEntry[];
  /** Pass back as `?cursor=` for the next page; null when exhausted. */
  nextCursor: number | null;
}
