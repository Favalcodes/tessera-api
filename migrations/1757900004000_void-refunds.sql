-- Up Migration
-- =============================================================================
-- A voided round reveals its seed like any other.
--
-- That matters more than it looks. Voiding is the one power the operator has to
-- make a round not count, so an operator who could void silently could dodge
-- large payouts by voiding whenever the drawn outcome was expensive. Revealing
-- on void means every void is auditable against the outcome it discarded, and a
-- pattern of convenient voids would be visible in the data.
-- =============================================================================

ALTER TABLE rounds DROP CONSTRAINT rounds_seed_revealed_only_after_crash;

ALTER TABLE rounds ADD CONSTRAINT rounds_seed_revealed_only_after_crash CHECK (
  seed_revealed IS NULL OR status IN ('CRASHED', 'SETTLED', 'VOIDED')
);

-- A voided round never flew to a conclusion, so it has no crash time.
ALTER TABLE rounds ADD CONSTRAINT rounds_voided_has_no_crash CHECK (
  status <> 'VOIDED' OR crashed_at IS NULL
);

-- Down Migration
ALTER TABLE rounds DROP CONSTRAINT IF EXISTS rounds_voided_has_no_crash;
ALTER TABLE rounds DROP CONSTRAINT rounds_seed_revealed_only_after_crash;
ALTER TABLE rounds ADD CONSTRAINT rounds_seed_revealed_only_after_crash CHECK (
  seed_revealed IS NULL OR status IN ('CRASHED', 'SETTLED')
);
