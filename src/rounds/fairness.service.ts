import { Injectable } from '@nestjs/common';
import type { FairnessProof } from '@tessera/contracts';
import { DatabaseService } from '../database/database.service';
import { RoundNotFoundError } from './exceptions/rounds.exceptions';
import { HashChainFairnessProvider } from './fairness/hash-chain-fairness.provider';

/**
 * Everything a player needs to check a round without trusting this server.
 *
 * The algorithm is spelled out in the response rather than left to the docs. A
 * verification anyone can run only if they first read a README and guess the
 * details correctly is not much of a verification.
 */
@Injectable()
export class FairnessService {
  constructor(
    private readonly database: DatabaseService,
    private readonly provider: HashChainFairnessProvider,
  ) {}

  async getProof(roundId: string): Promise<FairnessProof> {
    const round = await this.database.db
      .selectFrom('rounds')
      .leftJoin('fairness_chains', 'fairness_chains.id', 'rounds.chain_id')
      .select([
        'rounds.id as id',
        'rounds.nonce as nonce',
        'rounds.status as status',
        'rounds.seed_hash as seed_hash',
        'rounds.seed_revealed as seed_revealed',
        'rounds.crash_point_bp as crash_point_bp',
        'rounds.chain_index as chain_index',
        'fairness_chains.genesis_hash as genesis_hash',
        'fairness_chains.length as chain_length',
      ])
      .where('rounds.id', '=', roundId)
      .executeTakeFirst();

    if (!round) throw new RoundNotFoundError(roundId);

    const concluded = round.status === 'RESOLVED' || round.status === 'SETTLED';
    const revealed = concluded || round.status === 'VOIDED';

    return {
      roundId: round.id,
      nonce: Number(round.nonce),
      seedHash: round.seed_hash,
      // Same disclosure rules as the round itself: nothing that would hand a
      // player the outcome before they bet.
      seedRevealed: revealed ? round.seed_revealed : null,
      crashPointBp: concluded ? round.crash_point_bp : null,
      genesisHash: round.genesis_hash ?? '',
      chainIndex: round.chain_index ?? 0,
      chainLength: round.chain_length ?? 0,
      algorithm: {
        seedHash: 'sha256(seed)',
        outcomeHash: 'hmac_sha256(key = seed, message = nonce)',
        crashPoint:
          'bustRoll = parseInt(outcomeHash[0..8], 16); if bustRoll % 101 == 0 then 1.00x, ' +
          'else h = parseInt(outcomeHash[8..21], 16), e = 2^52, ' +
          'crash = floor((100e - h) / (e - h)) / 100',
        chain:
          'sha256 applied to the revealed seed chainIndex times equals genesisHash, ' +
          'which was published before this chain\'s first round opened',
      },
    };
  }

  /** The commitments themselves, so anyone can record them independently. */
  async listChains() {
    const rows = await this.database.db
      .selectFrom('fairness_chains')
      .select(['id', 'genesis_hash', 'length', 'first_nonce', 'created_at'])
      .orderBy('first_nonce', 'asc')
      .execute();

    return rows.map((row) => ({
      id: row.id,
      genesisHash: row.genesis_hash,
      length: row.length,
      firstNonce: Number(row.first_nonce),
      committedAt: row.created_at.toISOString(),
    }));
  }

  /** Recompute an outcome from a seed, through the generation path itself. */
  reproduce(seed: string, nonce: number) {
    return this.provider.verify(seed, nonce);
  }
}
