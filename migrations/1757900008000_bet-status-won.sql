-- Up Migration
-- =============================================================================
-- A roulette winner is not "cashed out".
--
-- Cashing out is a crash-specific action — a decision the player makes while the
-- round is running. A roulette bet has no such moment: it is placed, the wheel
-- resolves, and it won or it did not. Keeping CASHED_OUT as the winning status
-- for both would describe roulette in crash's vocabulary, the same mistake as
-- leaving a roulette round in status FLYING.
--
-- WON covers both: crash pays out at the multiplier the player cashed out at,
-- roulette at the odds its selection was accepted at. One settlement vocabulary,
-- with the game supplying the multiplier.
-- =============================================================================

ALTER TYPE bet_status RENAME VALUE 'CASHED_OUT' TO 'WON';

ALTER TABLE bets RENAME COLUMN cashout_multiplier_bp TO settled_multiplier_bp;

-- Down Migration
ALTER TABLE bets RENAME COLUMN settled_multiplier_bp TO cashout_multiplier_bp;
ALTER TYPE bet_status RENAME VALUE 'WON' TO 'CASHED_OUT';
