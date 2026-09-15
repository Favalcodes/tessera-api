import type { Kysely, Transaction } from 'kysely';
import type { Money } from '../common/value-objects/money';
import type { DB } from '../database/database.types';

/** Either a pooled connection or an open transaction. */
export type Executor = Kysely<DB> | Transaction<DB>;

export const TransactionKind = {
  /** MINT -> WALLET. The only way credits enter the system. */
  SIGNUP_GRANT: 'SIGNUP_GRANT',
  /** WALLET -> ESCROW. Stake leaves the player for the duration of the round. */
  BET_PLACED: 'BET_PLACED',
  /** ESCROW -> WALLET (stake) and HOUSE -> WALLET (profit). */
  BET_CASHOUT: 'BET_CASHOUT',
  /** ESCROW -> HOUSE. The player was still in at the crash. */
  BET_LOST: 'BET_LOST',
  /** ESCROW -> WALLET. A round could not be resolved; stakes are returned. */
  ROUND_VOID_REFUND: 'ROUND_VOID_REFUND',
} as const;

export type TransactionKind = (typeof TransactionKind)[keyof typeof TransactionKind];

export interface Posting {
  accountId: string;
  /** Signed: negative debits the account, positive credits it. */
  amount: Money;
}

export interface PostInput {
  kind: TransactionKind;
  postings: Posting[];
  reference?: { type: string; id: string };
}

export interface PostedTransaction {
  id: string;
  kind: TransactionKind;
  postings: Posting[];
}

export interface LedgerEntryView {
  id: number;
  transactionId: string;
  transactionKind: string;
  amount: Money;
  balanceAfter: Money | null;
  referenceType: string | null;
  referenceId: string | null;
  createdAt: Date;
}
