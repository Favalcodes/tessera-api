import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { timingSafeEqual } from 'node:crypto';
import type { Env } from '../config/env';
import { Money } from '../common/money';
import { DatabaseService } from '../database/database.service';
import { SYSTEM_ACCOUNTS } from '../database/schema';
import { LedgerService } from '../ledger/ledger.service';
import { TransactionKind } from '../ledger/ledger.types';
import {
  EmailAlreadyRegisteredError,
  InvalidCredentialsError,
  InvalidRefreshTokenError,
  RefreshTokenReuseError,
} from './auth.errors';
import type { LoginDto, RegisterDto } from './dto/auth.dto';
import { TokensService } from './tokens.service';

export interface AuthenticatedUser {
  id: string;
  email: string;
  displayName: string;
  role: string;
}

export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: AuthenticatedUser;
}

/**
 * argon2id parameters. Deliberately above the library defaults: this is the one
 * place in the request path where being slow is the point.
 */
const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19_456, // 19 MiB — the OWASP baseline
  timeCost: 2,
  parallelism: 1,
};

/**
 * A precomputed hash of a value nobody can log in with. Verified against when an
 * email does not exist, so a login attempt for an unknown address costs the same
 * as one for a known address — otherwise response timing enumerates the user
 * table for free.
 */
let dummyHashPromise: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  dummyHashPromise ??= argon2.hash('tessera-nonexistent-account-placeholder', ARGON2_OPTIONS);
  return dummyHashPromise;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly ledger: LedgerService,
    private readonly tokens: TokensService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * Register a user.
   *
   * The user row, the wallet account and the opening grant are one database
   * transaction. There is deliberately no path that produces a user without a
   * wallet, or a wallet without its grant — a partially-registered account would
   * be a balance that cannot be explained from the ledger, which is precisely
   * what this system claims is impossible.
   *
   * Note the grant is an ordinary `LedgerService.post`, not a special case. The
   * opening balance is MINT -> WALLET like any other movement, so it shows up in
   * history and counts toward credits-in-circulation for free.
   */
  async register(dto: RegisterDto): Promise<AuthResult> {
    const existing = await this.database.db
      .selectFrom('users')
      .select(['id'])
      .where('email', '=', dto.email)
      .executeTakeFirst();

    if (existing) throw new EmailAlreadyRegisteredError();

    const passwordHash = await argon2.hash(dto.password, ARGON2_OPTIONS);
    const grant = Money.fromMinor(this.config.get('SIGNUP_GRANT_MINOR', { infer: true }));

    try {
      return await this.database.db.transaction().execute(async (trx) => {
        const user = await trx
          .insertInto('users')
          .values({
            email: dto.email,
            display_name: dto.displayName.trim(),
            password_hash: passwordHash,
          })
          .returning(['id', 'email', 'display_name', 'role'])
          .executeTakeFirstOrThrow();

        const walletId = await this.ledger.createWallet(user.id, trx);

        await this.ledger.post(
          {
            kind: TransactionKind.SIGNUP_GRANT,
            reference: { type: 'user', id: user.id },
            postings: [
              { accountId: SYSTEM_ACCOUNTS.MINT, amount: Money.negate(grant) },
              { accountId: walletId, amount: grant },
            ],
          },
          trx,
        );

        const { token: refreshToken } = await this.tokens.issueRefreshToken(user.id, trx);

        return this.buildResult(
          { id: user.id, email: user.email, displayName: user.display_name, role: user.role },
          refreshToken,
        );
      });
    } catch (error) {
      // The uniqueness check above is racy by nature; the unique index is the
      // actual arbiter. Translate its violation into the same domain error so a
      // near-simultaneous double signup reads identically to a sequential one.
      if (isUniqueViolation(error, 'users_email_key')) {
        throw new EmailAlreadyRegisteredError();
      }
      throw error;
    }
  }

  async login(dto: LoginDto): Promise<AuthResult> {
    const user = await this.database.db
      .selectFrom('users')
      .select(['id', 'email', 'display_name', 'role', 'password_hash', 'status'])
      .where('email', '=', dto.email)
      .executeTakeFirst();

    // Always perform a verification, even with no matching user, so the timing
    // of a failed login does not reveal whether the address exists.
    const hash = user?.password_hash ?? (await getDummyHash());
    const passwordValid = await argon2.verify(hash, dto.password).catch(() => false);

    if (!user || !passwordValid) {
      throw new InvalidCredentialsError();
    }

    if (user.status === 'suspended') {
      throw new InvalidCredentialsError();
    }

    return this.database.db.transaction().execute(async (trx) => {
      const { token: refreshToken } = await this.tokens.issueRefreshToken(user.id, trx);
      return this.buildResult(
        { id: user.id, email: user.email, displayName: user.display_name, role: user.role },
        refreshToken,
      );
    });
  }

  /**
   * Rotate a refresh token.
   *
   * Presenting a token that has already been spent means either theft-and-replay
   * or a client racing itself. Both get the same treatment: revoke the entire
   * family. Forcing a legitimate user to log in again is a small cost; leaving a
   * stolen token live is not.
   */
  async refresh(rawToken: string): Promise<AuthResult> {
    // Verify the signature and expiry before touching the database: an
    // unsigned or expired token should never cost a query.
    try {
      this.tokens.verifyRefreshToken(rawToken);
    } catch {
      throw new InvalidRefreshTokenError();
    }

    const tokenHash = this.tokens.hashToken(rawToken);

    // The outcome is returned rather than thrown from inside the transaction.
    //
    // Throwing would roll the transaction back — and on the reuse path that
    // would roll back the revocation itself, leaving the compromised family
    // fully usable while the logs claimed it had been revoked. The revocation
    // has to commit; only then does the caller get an error.
    type RefreshOutcome =
      | { kind: 'ok'; result: AuthResult }
      | { kind: 'invalid' }
      | { kind: 'reuse' };

    const outcome = await this.database.db.transaction().execute<RefreshOutcome>(async (trx) => {
      const stored = await trx
        .selectFrom('refresh_tokens')
        .select(['id', 'user_id', 'family_id', 'used_at', 'revoked_at', 'expires_at'])
        .where('token_hash', '=', tokenHash)
        .forUpdate()
        .executeTakeFirst();

      if (!stored || stored.revoked_at) return { kind: 'invalid' };
      if (stored.expires_at.getTime() <= Date.now()) return { kind: 'invalid' };

      if (stored.used_at) {
        this.logger.warn(
          `refresh token reuse detected for user ${stored.user_id}; revoking family ${stored.family_id}`,
        );
        // Revoked inside the transaction, under the row lock taken above, so a
        // concurrent refresh on the same family cannot slip between detection
        // and revocation.
        await this.tokens.revokeFamily(stored.family_id, trx);
        return { kind: 'reuse' };
      }

      await trx
        .updateTable('refresh_tokens')
        .set({ used_at: new Date() })
        .where('id', '=', stored.id)
        .execute();

      const user = await trx
        .selectFrom('users')
        .select(['id', 'email', 'display_name', 'role', 'status'])
        .where('id', '=', stored.user_id)
        .executeTakeFirst();

      if (!user || user.status === 'suspended') return { kind: 'invalid' };

      const { token: refreshToken } = await this.tokens.issueRefreshToken(
        user.id,
        trx,
        stored.family_id,
      );

      return {
        kind: 'ok',
        result: this.buildResult(
          { id: user.id, email: user.email, displayName: user.display_name, role: user.role },
          refreshToken,
        ),
      };
    });

    if (outcome.kind === 'reuse') throw new RefreshTokenReuseError();
    if (outcome.kind === 'invalid') throw new InvalidRefreshTokenError();
    return outcome.result;
  }

  /** Log out by revoking the presented token's whole family. */
  async logout(rawToken: string): Promise<void> {
    const tokenHash = this.tokens.hashToken(rawToken);

    const stored = await this.database.db
      .selectFrom('refresh_tokens')
      .select(['family_id'])
      .where('token_hash', '=', tokenHash)
      .executeTakeFirst();

    // Logging out with an unknown token is not an error — the desired end state
    // (that token cannot be used) already holds.
    if (stored) await this.tokens.revokeFamily(stored.family_id);
  }

  private buildResult(user: AuthenticatedUser, refreshToken: string): AuthResult {
    return {
      accessToken: this.tokens.signAccessToken({
        sub: user.id,
        email: user.email,
        role: user.role,
      }),
      refreshToken,
      expiresIn: this.config.get('JWT_ACCESS_TTL', { infer: true }),
      user,
    };
  }
}

/** Narrow a Postgres unique-violation error without an `any` cast. */
function isUniqueViolation(error: unknown, constraint?: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; constraint?: unknown };
  if (candidate.code !== '23505') return false;
  if (!constraint) return true;
  return candidate.constraint === constraint;
}

/** Kept for parity with future constant-time comparisons on opaque tokens. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
