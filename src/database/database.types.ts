import type { ColumnType, Generated } from 'kysely';

/**
 * Kysely's view of the schema. Hand-maintained to match `migrations/`, which is
 * the source of truth — the migrations own the constraints, and those are the
 * part that actually enforces anything.
 */

export type AccountKind = 'MINT' | 'WALLET' | 'ESCROW' | 'HOUSE';
export type UserRole = 'user' | 'admin';
export type UserStatus = 'active' | 'suspended' | 'pending_verification';

/** Written by the database default, never supplied, readable as a Date. */
type CreatedAt = ColumnType<Date, never, never>;
/** Nullable timestamp the application may set. */
type NullableTimestamp = ColumnType<Date | null, Date | null | undefined, Date | null>;

export interface UsersTable {
  id: Generated<string>;
  email: string;
  display_name: string;
  password_hash: string;
  role: Generated<UserRole>;
  status: Generated<UserStatus>;
  email_verified_at: NullableTimestamp;
  created_at: CreatedAt;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

export interface AccountsTable {
  id: Generated<string>;
  kind: AccountKind;
  owner_user_id: string | null;
  key: string;
  created_at: CreatedAt;
}

export interface TransactionsTable {
  id: Generated<string>;
  kind: string;
  reference_type: string | null;
  reference_id: string | null;
  created_at: CreatedAt;
}

export interface EntriesTable {
  id: Generated<number>;
  transaction_id: string;
  account_id: string;
  /** Signed minor units. Append-only: never update, never delete. */
  amount: number;
  created_at: CreatedAt;
}

export interface BalancesTable {
  account_id: string;
  balance: ColumnType<number, number | undefined, number>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

export interface RefreshTokensTable {
  id: Generated<string>;
  user_id: string;
  family_id: string;
  token_hash: string;
  expires_at: ColumnType<Date, Date, Date>;
  used_at: NullableTimestamp;
  revoked_at: NullableTimestamp;
  created_at: CreatedAt;
}

export type RoundStatusDb = 'OPEN' | 'LOCKED' | 'FLYING' | 'CRASHED' | 'SETTLED' | 'VOIDED';
export type BetStatusDb = 'ACTIVE' | 'CASHED_OUT' | 'LOST' | 'VOIDED';

export interface RoundsTable {
  id: Generated<string>;
  nonce: Generated<number>;
  status: Generated<RoundStatusDb>;
  /** Private. Never select this into an API response. */
  seed: string;
  seed_hash: string;
  seed_revealed: string | null;
  crash_point_bp: number;
  opens_at: Generated<Date>;
  locks_at: ColumnType<Date, Date, Date>;
  started_at: NullableTimestamp;
  crashed_at: NullableTimestamp;
  settled_at: NullableTimestamp;
  created_at: CreatedAt;
  /** Which committed chain this round's seed came from. */
  chain_id: string | null;
  /** Its position in that chain: round `i` uses `s[i]`. */
  chain_index: number | null;
}

export interface FairnessChainsTable {
  id: Generated<string>;
  genesis_hash: string;
  /** Secret. Never select this into an API response. */
  terminal_seed: string;
  length: number;
  first_nonce: number;
  created_at: CreatedAt;
}

export interface BetsTable {
  id: Generated<string>;
  user_id: string;
  round_id: string;
  stake_minor: number;
  status: Generated<BetStatusDb>;
  cashout_multiplier_bp: number | null;
  payout_minor: number | null;
  idempotency_key: string;
  created_at: CreatedAt;
  settled_at: NullableTimestamp;
}

export interface DB {
  users: UsersTable;
  accounts: AccountsTable;
  transactions: TransactionsTable;
  entries: EntriesTable;
  balances: BalancesTable;
  refresh_tokens: RefreshTokensTable;
  rounds: RoundsTable;
  fairness_chains: FairnessChainsTable;
  bets: BetsTable;
}

/** Fixed ids for the singleton system accounts, seeded in the initial migration. */
export const SYSTEM_ACCOUNTS = {
  MINT: '00000000-0000-0000-0000-000000000001',
  ESCROW: '00000000-0000-0000-0000-000000000002',
  HOUSE: '00000000-0000-0000-0000-000000000003',
} as const;

export function walletKey(userId: string): string {
  return `USER:${userId}:WALLET`;
}
