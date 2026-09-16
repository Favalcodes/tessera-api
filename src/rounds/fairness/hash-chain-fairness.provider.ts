import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { crashPointFromHash, deriveChainSeed } from '@tessera/contracts';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { Env } from '../../config/env.validation';
import { DatabaseService } from '../../database/database.service';
import type { FairnessProvider, RoundOutcome } from './fairness.provider';

const sha256 = (input: string): string => createHash('sha256').update(input).digest('hex');

export interface ActiveChain {
  id: string;
  genesisHash: string;
  length: number;
  firstNonce: number;
}

/**
 * Outcomes from a pre-committed hash chain.
 *
 * Replaces commit/reveal, which proved the server did not change its mind after
 * seeing the bets but not that it had not drawn many seeds beforehand and kept a
 * convenient one. Here the entire sequence is fixed before the first round runs,
 * and any revealed seed hashes forward to a commitment published before it.
 *
 * Only the terminal seed is stored. Every other seed is derived by hashing, so
 * there is no table of pending secrets — and deriving `s[i]` costs `N - i`
 * hashes, which is microseconds even for a long chain.
 */
@Injectable()
export class HashChainFairnessProvider implements FairnessProvider {
  private readonly logger = new Logger(HashChainFairnessProvider.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  private get db() {
    return this.database.db;
  }

  async drawOutcome(nonce: number): Promise<RoundOutcome> {
    const chain = await this.chainFor(nonce);
    const index = nonce - chain.firstNonce + 1;

    const seed = await deriveChainSeed(
      await this.terminalSeedOf(chain.id),
      chain.length,
      index,
      sha256,
    );

    const { seedHash, crashPointBp } = this.verify(seed, nonce);

    return { seed, seedHash, crashPointBp, chainId: chain.id, chainIndex: index };
  }

  /**
   * Reproduce an outcome from a seed.
   *
   * The same code path a player runs, so verification cannot drift from
   * generation the way a parallel implementation would.
   */
  verify(seed: string, nonce: number): { seedHash: string; crashPointBp: number } {
    // The nonce is mixed in by HMAC rather than concatenation, so knowing one
    // round's outcome reveals nothing about the rest of the chain.
    const outcomeHash = createHmac('sha256', seed).update(String(nonce)).digest('hex');
    return { seedHash: sha256(seed), crashPointBp: crashPointFromHash(outcomeHash) };
  }

  /** The chain covering this nonce, creating one if the last is exhausted. */
  async chainFor(nonce: number): Promise<ActiveChain> {
    const existing = await this.db
      .selectFrom('fairness_chains')
      .select(['id', 'genesis_hash', 'length', 'first_nonce'])
      .where('first_nonce', '<=', nonce)
      .orderBy('first_nonce', 'desc')
      .executeTakeFirst();

    if (existing && nonce < existing.first_nonce + existing.length) {
      return {
        id: existing.id,
        genesisHash: existing.genesis_hash,
        length: existing.length,
        firstNonce: Number(existing.first_nonce),
      };
    }

    return this.createChain(nonce);
  }

  /**
   * Build a new chain backwards from a random terminal seed and publish its
   * genesis hash.
   *
   * A chain is finite, so an exhausted one is succeeded by another. The
   * succession is visible — each chain records the nonce it starts at, and its
   * genesis is committed before that nonce is reached — which is the honest way
   * to handle it. Silently rolling into a fresh chain would hand the operator
   * back exactly the freedom the chain exists to remove.
   */
  private async createChain(firstNonce: number): Promise<ActiveChain> {
    const length = this.config.get('FAIRNESS_CHAIN_LENGTH', { infer: true });
    const terminalSeed = randomBytes(32).toString('hex');

    // s[0] = sha256(s[1]); s[1] is the terminal seed hashed length-1 times.
    const firstSeed = await deriveChainSeed(terminalSeed, length, 1, sha256);
    const genesisHash = sha256(firstSeed);

    const row = await this.db
      .insertInto('fairness_chains')
      .values({
        genesis_hash: genesisHash,
        terminal_seed: terminalSeed,
        length,
        first_nonce: firstNonce,
      })
      .returning(['id', 'genesis_hash', 'length', 'first_nonce'])
      .executeTakeFirstOrThrow();

    this.logger.log(
      `Committed a new fairness chain of ${length} rounds from nonce ${firstNonce}; genesis ${genesisHash}`,
    );

    return {
      id: row.id,
      genesisHash: row.genesis_hash,
      length: row.length,
      firstNonce: Number(row.first_nonce),
    };
  }

  private async terminalSeedOf(chainId: string): Promise<string> {
    const row = await this.db
      .selectFrom('fairness_chains')
      .select(['terminal_seed'])
      .where('id', '=', chainId)
      .executeTakeFirstOrThrow();

    return row.terminal_seed;
  }
}
