import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomUUID } from 'node:crypto';
import type { Transaction } from 'kysely';
import type { Env } from '../config/env';
import { DatabaseService } from '../database/database.service';
import type { DB } from '../database/schema';

export interface AccessTokenPayload {
  sub: string;
  email: string;
  role: string;
}

interface RefreshTokenPayload {
  sub: string;
  jti: string;
  fam: string;
}

@Injectable()
export class TokensService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService<Env, true>,
    private readonly database: DatabaseService,
  ) {}

  /**
   * Refresh tokens are stored as a SHA-256 digest, never in the clear.
   *
   * Plain SHA-256 rather than argon2 is the right call *here* specifically
   * because a refresh token is 128 bits of server-generated randomness, not a
   * human-chosen password — there is no dictionary to attack, so the slow hash
   * buys nothing and would add real latency to every refresh.
   */
  hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  signAccessToken(payload: AccessTokenPayload): string {
    return this.jwt.sign(payload, {
      secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }),
      expiresIn: this.config.get('JWT_ACCESS_TTL', { infer: true }),
    });
  }

  verifyAccessToken(token: string): AccessTokenPayload {
    return this.jwt.verify<AccessTokenPayload>(token, {
      secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }),
    });
  }

  /**
   * Issue a refresh token into a family, persisting only its hash.
   * `familyId` is omitted on login (starting a new family) and carried through
   * on every rotation, so a whole lineage can be revoked at once.
   */
  async issueRefreshToken(
    userId: string,
    trx: Transaction<DB>,
    familyId: string = randomUUID(),
  ): Promise<{ token: string; familyId: string }> {
    const jti = randomUUID();
    const ttl = this.config.get('JWT_REFRESH_TTL', { infer: true });

    const token = this.jwt.sign(
      { sub: userId, jti, fam: familyId } satisfies RefreshTokenPayload,
      {
        secret: this.config.get('JWT_REFRESH_SECRET', { infer: true }),
        expiresIn: ttl,
      },
    );

    await trx
      .insertInto('refresh_tokens')
      .values({
        user_id: userId,
        family_id: familyId,
        token_hash: this.hashToken(token),
        expires_at: new Date(Date.now() + ttl * 1000),
      })
      .execute();

    return { token, familyId };
  }

  verifyRefreshToken(token: string): RefreshTokenPayload {
    return this.jwt.verify<RefreshTokenPayload>(token, {
      secret: this.config.get('JWT_REFRESH_SECRET', { infer: true }),
    });
  }

  /** Revoke every unrevoked token in a family. The reuse-detection response. */
  async revokeFamily(familyId: string, trx?: Transaction<DB>): Promise<void> {
    const executor = trx ?? this.database.db;
    await executor
      .updateTable('refresh_tokens')
      .set({ revoked_at: new Date() })
      .where('family_id', '=', familyId)
      .where('revoked_at', 'is', null)
      .execute();
  }
}
