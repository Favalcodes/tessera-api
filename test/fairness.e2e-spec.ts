import type { INestApplication } from '@nestjs/common';
import { crashPointFromHash, verifyChainProof } from '@tessera/contracts';
import type { Kysely } from 'kysely';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { DB } from '../src/database/database.types';
import { FairnessService } from '../src/rounds/fairness.service';
import { HashChainFairnessProvider } from '../src/rounds/fairness/hash-chain-fairness.provider';
import { RoundEngineService } from '../src/rounds/round-engine.service';
import { RoundsService } from '../src/rounds/rounds.service';
import { createTestApp, resetDatabase } from './helpers/test-app';

const sha256 = (input: string) => createHash('sha256').update(input).digest('hex');

/**
 * The fairness claim, checked the way a sceptical player would check it.
 *
 * Every assertion here is computed independently of the server's own answer —
 * hashing the revealed seed, recomputing the outcome from scratch — because a
 * verification that asks the server whether the server is honest proves nothing.
 */
describe('Provable fairness: pre-committed hash chain', () => {
  let app: INestApplication;
  let db: Kysely<DB>;
  let engine: RoundEngineService;
  let rounds: RoundsService;
  let fairness: FairnessService;
  let provider: HashChainFairnessProvider;

  const http = () => request(app.getHttpServer() as App);

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    db = ctx.db;
    engine = app.get(RoundEngineService);
    rounds = app.get(RoundsService);
    fairness = app.get(FairnessService);
    provider = app.get(HashChainFairnessProvider);
  });

  beforeEach(async () => {
    await resetDatabase(db);
    await db.deleteFrom('fairness_chains').execute();
  });

  afterAll(async () => {
    await app.close();
  });

  /** Drive a round to CRASHED so its seed is revealed. */
  async function runRoundToCrash(): Promise<string> {
    const roundId = await engine.openRoundIfDue();
    if (!roundId) throw new Error('no round opened');

    await db.updateTable('rounds').set({ locks_at: new Date(0) }).where('id', '=', roundId).execute();
    await engine.tick(); // LOCKED
    await engine.tick(); // FLYING

    const { elapsedAtMultiplier } = await import('@tessera/contracts');
    const round = await db
      .selectFrom('rounds')
      .select(['crash_point_bp'])
      .where('id', '=', roundId)
      .executeTakeFirstOrThrow();

    const { sql } = await import('kysely');
    await db
      .updateTable('rounds')
      .set({
        started_at: sql<Date>`clock_timestamp() - make_interval(secs => ${
          elapsedAtMultiplier(round.crash_point_bp) / 1000
        })`,
      })
      .where('id', '=', roundId)
      .execute();

    await engine.tick(); // CRASHED
    return roundId;
  }

  it('commits a genesis hash before the first round opens', async () => {
    const before = await fairness.listChains();
    expect(before).toHaveLength(0);

    await engine.openRoundIfDue();

    const after = await fairness.listChains();
    expect(after).toHaveLength(1);
    expect(after[0]!.genesisHash).toHaveLength(64);
    expect(after[0]!.length).toBeGreaterThan(0);
  });

  it('hashes a revealed seed forward to the genesis published before it', async () => {
    const roundId = await runRoundToCrash();
    const proof = await fairness.getProof(roundId);

    expect(proof.seedRevealed).not.toBeNull();
    expect(proof.chainIndex).toBeGreaterThan(0);

    // The whole claim, computed here rather than asked of the server.
    const result = await verifyChainProof(
      {
        seed: proof.seedRevealed!,
        chainIndex: proof.chainIndex,
        genesisHash: proof.genesisHash,
      },
      sha256,
    );

    expect(result.valid).toBe(true);
    expect(result.steps).toBe(proof.chainIndex);
  });

  it('rejects a seed that was not part of the chain', async () => {
    const roundId = await runRoundToCrash();
    const proof = await fairness.getProof(roundId);

    const forged = await verifyChainProof(
      {
        seed: randomBytes(32).toString('hex'),
        chainIndex: proof.chainIndex,
        genesisHash: proof.genesisHash,
      },
      sha256,
    );

    expect(forged.valid).toBe(false);
  });

  it('lets the outcome be recomputed from the seed with no server involvement', async () => {
    const roundId = await runRoundToCrash();
    const proof = await fairness.getProof(roundId);

    // Exactly the algorithm the response describes.
    const outcomeHash = createHmac('sha256', proof.seedRevealed!)
      .update(String(proof.nonce))
      .digest('hex');

    expect(sha256(proof.seedRevealed!)).toBe(proof.seedHash);
    expect(crashPointFromHash(outcomeHash)).toBe(proof.crashPointBp);
  });

  it('withholds the seed and the outcome until the round ends', async () => {
    const roundId = await engine.openRoundIfDue();
    const proof = await fairness.getProof(roundId!);

    expect(proof.seedHash).toHaveLength(64);
    // The commitment is public from the start; what it commits to is not.
    expect(proof.seedRevealed).toBeNull();
    expect(proof.crashPointBp).toBeNull();

    const overHttp = await http().get(`/rounds/${roundId!}/fairness`).expect(200);
    expect(overHttp.body.seedRevealed).toBeNull();
    expect(overHttp.body.crashPointBp).toBeNull();
    // And the terminal seed must never appear anywhere.
    expect(JSON.stringify(overHttp.body)).not.toContain('terminal');
  });

  it('never returns the chain secret from the public chains endpoint', async () => {
    await engine.openRoundIfDue();

    const res = await http().get('/rounds/fairness/chains').expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toHaveProperty('genesisHash');
    expect(res.body[0]).not.toHaveProperty('terminalSeed');
    expect(res.body[0]).not.toHaveProperty('terminal_seed');
  });

  it('gives consecutive rounds consecutive, non-repeating chain positions', async () => {
    const first = await runRoundToCrash();
    await engine.tick(); // settle, freeing the live-round slot
    const second = await runRoundToCrash();

    const a = await fairness.getProof(first);
    const b = await fairness.getProof(second);

    expect(b.chainIndex).toBe(a.chainIndex + 1);
    expect(a.seedRevealed).not.toBe(b.seedRevealed);

    // Both verify against the same commitment.
    for (const proof of [a, b]) {
      const result = await verifyChainProof(
        { seed: proof.seedRevealed!, chainIndex: proof.chainIndex, genesisHash: proof.genesisHash },
        sha256,
      );
      expect(result.valid).toBe(true);
    }
  });

  it('reproduces an outcome through the same code path that generated it', async () => {
    const roundId = await runRoundToCrash();
    const proof = await fairness.getProof(roundId);

    const reproduced = provider.verify(proof.seedRevealed!, proof.nonce);

    expect(reproduced.seedHash).toBe(proof.seedHash);
    expect(reproduced.crashPointBp).toBe(proof.crashPointBp);
  });

  it('publishes the algorithm rather than leaving it to the documentation', async () => {
    const roundId = await engine.openRoundIfDue();
    const proof = await fairness.getProof(roundId!);

    expect(proof.algorithm.seedHash).toContain('sha256');
    expect(proof.algorithm.outcomeHash).toContain('hmac_sha256');
    expect(proof.algorithm.crashPoint).toContain('101');
    expect(proof.algorithm.chain).toContain('genesisHash');
  });

  it('reveals the seed of a voided round too, so voids are auditable', async () => {
    const roundId = await engine.openRoundIfDue();
    await db.updateTable('rounds').set({ locks_at: new Date(0) }).where('id', '=', roundId!).execute();
    await engine.tick();
    await engine.tick();

    const { sql } = await import('kysely');
    await db
      .updateTable('rounds')
      .set({ started_at: sql<Date>`clock_timestamp() - interval '10 minutes'` })
      .where('id', '=', roundId!)
      .execute();

    await engine.tick(); // stale -> voided

    const proof = await fairness.getProof(roundId!);
    expect(proof.seedRevealed).not.toBeNull();
    // No crash point: the outcome was discarded, not used.
    expect(proof.crashPointBp).toBeNull();

    const result = await verifyChainProof(
      { seed: proof.seedRevealed!, chainIndex: proof.chainIndex, genesisHash: proof.genesisHash },
      sha256,
    );
    expect(result.valid).toBe(true);
    void rounds;
  });
});
