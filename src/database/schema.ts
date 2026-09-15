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

export interface DB {
  users: UsersTable;
  accounts: AccountsTable;
  transactions: TransactionsTable;
  entries: EntriesTable;
  balances: BalancesTable;
  refresh_tokens: RefreshTokensTable;
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
