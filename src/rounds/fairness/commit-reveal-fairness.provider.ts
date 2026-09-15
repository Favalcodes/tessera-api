import { Injectable } from '@nestjs/common';
import { crashPointFromHash } from '@tessera/contracts';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { FairnessProvider, RoundOutcome } from './fairness.provider';

/**
 * Per-round commit / reveal (PRD 5.4).
 *
 * Before betting opens the server draws a random seed and publishes
 * `sha256(seed)`. After the round crashes it reveals the seed, and anyone can
 * confirm both that the hash matches and that the crash point follows from it.
 *
 * The honest limitation, worth stating because Phase 4 exists to remove it: this
 * proves the server did not change its mind *after* seeing the bets, but it does
 * not prove the server did not draw many seeds and publish a favourable one
 * before betting opened. A pre-committed hash chain closes that gap, because the
 * whole sequence is fixed before the first round runs.
 */
@Injectable()
export class CommitRevealFairnessProvider implements FairnessProvider {
  drawOutcome(nonce: number): Promise<RoundOutcome> {
    const seed = randomBytes(32).toString('hex');
    const { seedHash, crashPointBp } = this.verify(seed, nonce);
    return Promise.resolve({ seed, seedHash, crashPointBp });
  }

  verify(seed: string, nonce: number): { seedHash: string; crashPointBp: number } {
    const seedHash = createHash('sha256').update(seed).digest('hex');

    // The nonce is mixed in via HMAC rather than concatenation so that knowing
    // the outcome for one nonce reveals nothing about the others.
    const outcomeHash = createHmac('sha256', seed).update(String(nonce)).digest('hex');

    return { seedHash, crashPointBp: crashPointFromHash(outcomeHash) };
  }
}
