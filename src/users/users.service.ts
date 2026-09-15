import { Injectable, NotFoundException } from '@nestjs/common';
import type { Transaction } from 'kysely';
import { Money } from '../common/value-objects/money';
import { DatabaseService } from '../database/database.service';
import type { DB, UserRole, UserStatus } from '../database/database.types';
import { LedgerService } from '../ledger/ledger.service';
import type { LedgerQueryDto } from './dto/ledger-query.dto';

export interface UserRecord {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  status: UserStatus;
}

interface UserWithSecret extends UserRecord {
  passwordHash: string;
}

/**
 * Owns the `users` table.
 *
 * AuthService goes through here rather than querying users directly — the Nest
 * auth recipe, and it keeps one module responsible for the shape of a user.
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly database: DatabaseService,
    private readonly ledger: LedgerService,
  ) {}

  private get db() {
    return this.database.db;
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    const row = await this.db
      .selectFrom('users')
      .select(['id', 'email', 'display_name', 'role', 'status'])
      .where('email', '=', email)
      .executeTakeFirst();

    return row ? toRecord(row) : null;
  }

  /**
   * Includes the password hash, so it is deliberately separate from
   * `findByEmail` — a credential-bearing record should be awkward to obtain by
   * accident and obvious in a call site when it is.
   */
  async findByEmailWithSecret(email: string): Promise<UserWithSecret | null> {
    const row = await this.db
      .selectFrom('users')
      .select(['id', 'email', 'display_name', 'role', 'status', 'password_hash'])
      .where('email', '=', email)
      .executeTakeFirst();

    return row ? { ...toRecord(row), passwordHash: row.password_hash } : null;
  }

  async findById(id: string): Promise<UserRecord | null> {
    const row = await this.db
      .selectFrom('users')
      .select(['id', 'email', 'display_name', 'role', 'status'])
      .where('id', '=', id)
      .executeTakeFirst();

    return row ? toRecord(row) : null;
  }

  /**
   * Insert a user. Takes the caller's transaction because registration creates
   * the user, the wallet and the opening grant as one atomic unit.
   */
  async create(
    input: { email: string; displayName: string; passwordHash: string },
    trx: Transaction<DB>,
  ): Promise<UserRecord> {
    const row = await trx
      .insertInto('users')
      .values({
        email: input.email,
        display_name: input.displayName.trim(),
        password_hash: input.passwordHash,
      })
      .returning(['id', 'email', 'display_name', 'role', 'status'])
      .executeTakeFirstOrThrow();

    return toRecord(row);
  }

  async getBalance(userId: string): Promise<Money> {
    return this.ledger.getUserBalance(userId);
  }

  async getLedgerHistory(userId: string, query: LedgerQueryDto) {
    const accountId = await this.ledger.getWalletAccountId(userId);
    const page = await this.ledger.getHistory(accountId, {
      limit: query.limit,
      cursor: query.cursor,
      referenceType: query.referenceType,
    });

    return {
      entries: page.entries.map((entry) => ({
        id: entry.id,
        transactionId: entry.transactionId,
        kind: entry.transactionKind,
        amountMinor: entry.amount,
        amount: Money.format(entry.amount),
        direction: entry.amount < 0 ? ('debit' as const) : ('credit' as const),
        referenceType: entry.referenceType,
        referenceId: entry.referenceId,
        createdAt: entry.createdAt.toISOString(),
      })),
      nextCursor: page.nextCursor,
    };
  }

  async requireById(id: string): Promise<UserRecord> {
    const user = await this.findById(id);
    if (!user) throw new NotFoundException('Account not found');
    return user;
  }
}

function toRecord(row: {
  id: string;
  email: string;
  display_name: string;
  role: UserRole;
  status: UserStatus;
}): UserRecord {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
  };
}
