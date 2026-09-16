-- Up Migration
-- =============================================================================
-- Pre-committed hash chain (PRD 5.4, strengthened).
--
-- Commit/reveal proves the server did not change its mind after seeing the bets.
-- It does not prove the server did not draw many seeds before betting opened and
-- publish whichever it liked. A chain closes that gap.
--
-- Build it backwards from a random terminal seed:
--
--     s[N] = random
--     s[i] = sha256(s[i+1])
--
-- so s[0] depends on every seed in the chain. Publish s[0] before the first
-- round runs. Round i then uses s[i], revealed once it ends.
--
-- Given any revealed s[i], anyone can hash it forward i times and arrive at
-- s[0]. Since s[0] was published first, and sha256 cannot be run backwards, the
-- server could not have chosen s[i] after the fact — the whole sequence was
-- fixed before the first bet existed.
--
-- Only the terminal seed is stored. Every other seed is derived by hashing, so
-- there is no table of secrets to leak, and the chain's length costs nothing.
-- =============================================================================

CREATE TABLE fairness_chains (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- s[0]. Published before the chain's first round opens; this is the promise.
  genesis_hash  text        NOT NULL,

  -- s[N]. Secret for the life of the chain — it derives every unrevealed seed,
  -- so it must never be returned by any API path.
  terminal_seed text        NOT NULL,

  -- N: how many rounds this chain covers.
  length        integer     NOT NULL CHECK (length > 0),

  -- The round nonce that consumes s[1].
  first_nonce   bigint      NOT NULL,

  created_at    timestamptz NOT NULL DEFAULT now(),

  -- Chains must not overlap; a nonce belongs to exactly one.
  CONSTRAINT fairness_chains_first_nonce_unique UNIQUE (first_nonce)
);

-- Which chain a round drew from, and where in it. Stored rather than derived so
-- a verifier is handed the position instead of having to reconstruct it.
ALTER TABLE rounds
  ADD COLUMN chain_id    uuid REFERENCES fairness_chains (id) ON DELETE RESTRICT,
  ADD COLUMN chain_index integer CHECK (chain_index IS NULL OR chain_index > 0);

-- Two rounds cannot consume the same position in a chain. Without this, a
-- restart that replayed a nonce could reuse a seed, and a reused seed means a
-- predictable outcome for anyone who saw the first reveal.
CREATE UNIQUE INDEX rounds_chain_position ON rounds (chain_id, chain_index)
  WHERE chain_id IS NOT NULL;

-- Down Migration
DROP INDEX IF EXISTS rounds_chain_position;
ALTER TABLE rounds DROP COLUMN IF EXISTS chain_index;
ALTER TABLE rounds DROP COLUMN IF EXISTS chain_id;
DROP TABLE IF EXISTS fairness_chains;
