/**
 * Verifying a pre-committed hash chain.
 *
 * Kept here so the browser runs the same check the server does, and takes a hash
 * function rather than importing one — this package must compile unchanged in a
 * browser and on a server, and those have different crypto. The server passes a
 * `node:crypto` wrapper, the browser passes Web Crypto.
 */

/** Hex in, hex out. Async so Web Crypto's `subtle.digest` fits without adapters. */
export type Sha256Hex = (input: string) => string | Promise<string>;

export interface ChainProof {
  /** The seed the round revealed. */
  seed: string;
  /** Its position in the chain: round `i` uses `s[i]`. */
  chainIndex: number;
  /** `s[0]`, published before the chain's first round opened. */
  genesisHash: string;
}

export interface ChainVerification {
  valid: boolean;
  /** What hashing the revealed seed `chainIndex` times actually produced. */
  computedGenesis: string;
  /** How many hashes were performed. */
  steps: number;
}

/**
 * Hash a seed forward to the genesis commitment.
 *
 * `s[i] = sha256(s[i+1])`, so hashing a revealed `s[i]` exactly `i` times lands
 * on `s[0]`. If it does, that seed was part of the chain committed to before the
 * first round ran — sha256 cannot be run backwards, so it could not have been
 * chosen afterwards to suit the outcome.
 */
export async function verifyChainProof(
  proof: ChainProof,
  sha256: Sha256Hex,
): Promise<ChainVerification> {
  if (!Number.isInteger(proof.chainIndex) || proof.chainIndex < 1) {
    throw new RangeError('chainIndex must be a positive integer');
  }

  let current = proof.seed;
  for (let step = 0; step < proof.chainIndex; step += 1) {
    current = await sha256(current);
  }

  return {
    valid: current.toLowerCase() === proof.genesisHash.toLowerCase(),
    computedGenesis: current,
    steps: proof.chainIndex,
  };
}

/**
 * Derive `s[index]` from the terminal seed.
 *
 * Server-side only — it needs the secret. Exported here so generation and
 * verification share one definition of what the chain is, rather than two
 * implementations that agree until one is edited.
 */
export async function deriveChainSeed(
  terminalSeed: string,
  length: number,
  index: number,
  sha256: Sha256Hex,
): Promise<string> {
  if (!Number.isInteger(index) || index < 1 || index > length) {
    throw new RangeError(`index ${index} is outside a chain of length ${length}`);
  }

  let current = terminalSeed;
  for (let step = 0; step < length - index; step += 1) {
    current = await sha256(current);
  }
  return current;
}
