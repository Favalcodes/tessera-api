-- Up Migration
-- =============================================================================
-- Adds the VOIDED round status.
--
-- Separate from the migration that uses it because Postgres will not let a newly
-- added enum value be referenced in the same transaction that adds it.
-- =============================================================================

ALTER TYPE round_status ADD VALUE IF NOT EXISTS 'VOIDED';

-- Down Migration
-- Postgres cannot remove a value from an enum type. Reverting would mean
-- rebuilding the type and rewriting every dependent column, which is not worth
-- automating for a value that is only ever added.
SELECT 1;
