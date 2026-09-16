-- Up Migration
-- =============================================================================
-- Rounds become game-aware, and the lifecycle gets game-neutral names.
--
-- A roulette round sitting in status FLYING and then CRASHED would be nonsense.
-- The shape of the lifecycle is genuinely shared — open for bets, lock, run,
-- determine an outcome, settle — so the states are renamed rather than
-- duplicated per game:
--
--     FLYING   -> RUNNING    (crash: in flight;  roulette: ball in motion)
--     CRASHED  -> RESOLVED   (crash: crashed at; roulette: pocket known)
--
-- One state machine, one engine, per-game presentation.
-- =============================================================================

ALTER TYPE round_status RENAME VALUE 'FLYING' TO 'RUNNING';
ALTER TYPE round_status RENAME VALUE 'CRASHED' TO 'RESOLVED';

ALTER TABLE rounds RENAME COLUMN crashed_at TO resolved_at;

-- Down Migration
ALTER TABLE rounds RENAME COLUMN resolved_at TO crashed_at;
ALTER TYPE round_status RENAME VALUE 'RESOLVED' TO 'CRASHED';
ALTER TYPE round_status RENAME VALUE 'RUNNING' TO 'FLYING';
