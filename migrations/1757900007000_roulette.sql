-- Up Migration
-- =============================================================================
-- European roulette alongside crash.
--
-- The two games are deliberately opposite in the way that matters. Crash has a
-- single implicit bet and settlement that races the clock. Roulette has many
-- bet types at different odds, placed on one spin and settled together — so the
-- interesting work moves from timing to combinatorial settlement.
--
-- Single zero: 37 pockets, and every bet loses on 0. That one pocket is the
-- entire house edge, exactly 1/37 = 2.70%, which is the same for every bet type
-- on the table.
-- =============================================================================

CREATE TYPE game_kind AS ENUM ('CRASH', 'ROULETTE');

ALTER TABLE rounds
  ADD COLUMN game game_kind NOT NULL DEFAULT 'CRASH',
  -- 0-36. Drawn when the round opens, like a crash point, and withheld until
  -- the round resolves.
  ADD COLUMN winning_pocket smallint CHECK (winning_pocket IS NULL OR winning_pocket BETWEEN 0 AND 36);

-- A crash point is meaningless for roulette and vice versa.
ALTER TABLE rounds ALTER COLUMN crash_point_bp DROP NOT NULL;

ALTER TABLE rounds ADD CONSTRAINT rounds_outcome_matches_game CHECK (
  (game = 'CRASH'    AND crash_point_bp IS NOT NULL AND winning_pocket IS NULL) OR
  (game = 'ROULETTE' AND winning_pocket IS NOT NULL AND crash_point_bp IS NULL)
);

-- One live round PER GAME, rather than one overall. Both tables run at once,
-- and the engine still cannot open a duplicate of either.
DROP INDEX rounds_single_live_round;
CREATE UNIQUE INDEX rounds_single_live_round_per_game
  ON rounds (game)
  WHERE status IN ('OPEN', 'LOCKED', 'RUNNING');

CREATE INDEX rounds_game_created ON rounds (game, created_at DESC);

-- -----------------------------------------------------------------------------
-- Bets carry what was bet on.
--
-- A crash bet has no selection: there is only one thing to bet on. A roulette
-- bet names a selection and the odds it was accepted at — stored on the bet
-- rather than looked up at settlement, so that changing the odds table can never
-- retroactively change what an already-placed bet pays.
-- -----------------------------------------------------------------------------
ALTER TABLE bets
  ADD COLUMN selection_type  text,
  ADD COLUMN selection_value text,
  -- Total return multiplier in basis points: a straight-up win returns 36.00x,
  -- so 360000. Same units as a crash cash-out multiplier.
  ADD COLUMN odds_bp         integer CHECK (odds_bp IS NULL OR odds_bp > 10000);

ALTER TABLE bets ADD CONSTRAINT bets_selection_requires_odds CHECK (
  (selection_type IS NULL AND odds_bp IS NULL) OR
  (selection_type IS NOT NULL AND odds_bp IS NOT NULL)
);

-- A cashed-out bet is a crash concept; a roulette bet is never cashed out.
-- Winning roulette bets are settled to CASHED_OUT with their odds as the
-- multiplier, which keeps one settlement vocabulary across both games.

-- Down Migration
ALTER TABLE bets DROP CONSTRAINT IF EXISTS bets_selection_requires_odds;
ALTER TABLE bets DROP COLUMN IF EXISTS odds_bp;
ALTER TABLE bets DROP COLUMN IF EXISTS selection_value;
ALTER TABLE bets DROP COLUMN IF EXISTS selection_type;
DROP INDEX IF EXISTS rounds_game_created;
DROP INDEX IF EXISTS rounds_single_live_round_per_game;
CREATE UNIQUE INDEX rounds_single_live_round
  ON rounds ((status IN ('OPEN', 'LOCKED', 'RUNNING')))
  WHERE status IN ('OPEN', 'LOCKED', 'RUNNING');
ALTER TABLE rounds DROP CONSTRAINT IF EXISTS rounds_outcome_matches_game;
ALTER TABLE rounds DROP COLUMN IF EXISTS winning_pocket;
ALTER TABLE rounds DROP COLUMN IF EXISTS game;
DROP TYPE IF EXISTS game_kind;
