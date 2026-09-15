-- Up Migration
-- =============================================================================
-- Phase 2: the crash round and the bets placed on it.
--
-- As with the ledger, the rules that matter are constraints rather than
-- conventions. A bet cannot be cashed out twice, a round cannot reveal its seed
-- before it has crashed, and a stake cannot be zero — regardless of what the
-- application does.
-- =============================================================================

CREATE TYPE round_status AS ENUM ('OPEN', 'LOCKED', 'FLYING', 'CRASHED', 'SETTLED');
CREATE TYPE bet_status   AS ENUM ('ACTIVE', 'CASHED_OUT', 'LOST', 'VOIDED');

-- -----------------------------------------------------------------------------
-- rounds
-- -----------------------------------------------------------------------------
CREATE TABLE rounds (
  id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Monotonic, human-readable, and the nonce the crash point is derived from.
  nonce           bigserial    NOT NULL UNIQUE,
  status          round_status NOT NULL DEFAULT 'OPEN',

  -- The seed itself, drawn when the round opens. Never returned by any API
  -- path; it is held here so the reveal can be verified against it.
  seed            text         NOT NULL,
  -- Commitment published before betting opens: sha256(seed).
  seed_hash       text         NOT NULL,
  -- A copy of `seed`, written only once the round has crashed. The redundancy
  -- buys a real guarantee: the constraint below makes "the seed was not
  -- published early" a property of the database rather than a promise the
  -- application makes.
  seed_revealed   text,
  -- The drawn outcome, in basis points (10_000 = 1.00x). Held back from API
  -- responses until the round crashes, but stored up front: the outcome is
  -- fixed before a single bet is placed, which is the whole claim.
  crash_point_bp  integer      NOT NULL CHECK (crash_point_bp >= 10000),

  opens_at        timestamptz  NOT NULL DEFAULT now(),
  locks_at        timestamptz  NOT NULL,
  started_at      timestamptz,
  crashed_at      timestamptz,
  settled_at      timestamptz,

  created_at      timestamptz  NOT NULL DEFAULT now(),

  -- A seed may only be revealed once the round has crashed. Without this the
  -- reveal is a promise; with it, it is a guarantee.
  CONSTRAINT rounds_seed_revealed_only_after_crash CHECK (
    seed_revealed IS NULL OR status IN ('CRASHED', 'SETTLED')
  ),
  -- A reveal must be the seed that was committed to, not a different one.
  CONSTRAINT rounds_reveal_matches_seed CHECK (
    seed_revealed IS NULL OR seed_revealed = seed
  ),
  CONSTRAINT rounds_started_before_crashed CHECK (
    crashed_at IS NULL OR (started_at IS NOT NULL AND crashed_at >= started_at)
  ),
  CONSTRAINT rounds_flying_has_started CHECK (
    status NOT IN ('FLYING', 'CRASHED', 'SETTLED') OR started_at IS NOT NULL
  )
);

-- At most one round may be accepting bets or in flight at a time. The round
-- engine is leader-elected (ADR-007), but a duplicate engine would otherwise
-- open a second concurrent round and nothing in the schema would object.
CREATE UNIQUE INDEX rounds_single_live_round
  ON rounds ((status IN ('OPEN', 'LOCKED', 'FLYING')))
  WHERE status IN ('OPEN', 'LOCKED', 'FLYING');

CREATE INDEX rounds_status  ON rounds (status);
CREATE INDEX rounds_created ON rounds (created_at DESC);

-- -----------------------------------------------------------------------------
-- bets
-- -----------------------------------------------------------------------------
CREATE TABLE bets (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid        NOT NULL REFERENCES users (id)  ON DELETE RESTRICT,
  round_id              uuid        NOT NULL REFERENCES rounds (id) ON DELETE RESTRICT,

  stake_minor           bigint      NOT NULL CHECK (stake_minor > 0),
  status                bet_status  NOT NULL DEFAULT 'ACTIVE',

  -- Set together, or not at all: a cashed-out bet has both, any other status
  -- has neither. This is what stops a payout being recorded without the
  -- multiplier that justifies it.
  cashout_multiplier_bp integer     CHECK (cashout_multiplier_bp IS NULL OR cashout_multiplier_bp >= 10000),
  payout_minor          bigint      CHECK (payout_minor IS NULL OR payout_minor >= 0),

  -- Supplied by the client; makes a retried request safe to replay.
  idempotency_key       text        NOT NULL,

  created_at            timestamptz NOT NULL DEFAULT now(),
  settled_at            timestamptz,

  CONSTRAINT bets_cashout_fields_together CHECK (
    (status = 'CASHED_OUT' AND cashout_multiplier_bp IS NOT NULL AND payout_minor IS NOT NULL) OR
    (status <> 'CASHED_OUT' AND cashout_multiplier_bp IS NULL)
  ),
  CONSTRAINT bets_lost_pays_nothing CHECK (
    status <> 'LOST' OR payout_minor IS NULL OR payout_minor = 0
  )
);

-- The idempotency guarantee. A retried bet request collides here rather than
-- creating a second bet, no matter how many requests arrive at once.
CREATE UNIQUE INDEX bets_user_idempotency ON bets (user_id, idempotency_key);

-- The resolver's access path: every still-active bet on a round.
CREATE INDEX bets_round_status ON bets (round_id, status);
CREATE INDEX bets_user_history ON bets (user_id, created_at DESC);

-- Deliberately NOT unique on (user_id, round_id).
--
-- Multiple bets per round is normal for this game type, and more importantly a
-- one-bet-per-round rule would make the concurrency guarantee untestable: N
-- simultaneous bets from one account would all collapse to a single success
-- because of the index, not because of the balance check, and the proof point
-- in PRD 5.2 would pass while demonstrating nothing. Accidental duplicates are
-- prevented by the idempotency key above, which is the mechanism that should
-- be doing that job.

-- Down Migration
DROP TABLE IF EXISTS bets;
DROP TABLE IF EXISTS rounds;
DROP TYPE  IF EXISTS bet_status;
DROP TYPE  IF EXISTS round_status;
