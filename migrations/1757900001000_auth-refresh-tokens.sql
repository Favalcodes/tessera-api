-- Up Migration
-- =============================================================================
-- Refresh-token rotation with reuse detection.
--
-- Every login starts a token "family". Each refresh rotates the token and marks
-- the old one used. If a token that has already been used is presented again,
-- the only two explanations are a stolen token or a replay — so the entire family
-- is revoked, logging out whoever holds it, legitimate or not. That is the
-- correct trade: a forced re-login beats a live session in an attacker's hands.
-- =============================================================================

CREATE TABLE refresh_tokens (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- All tokens descended from a single login share a family_id.
  family_id  uuid        NOT NULL,
  -- SHA-256 of the token. The raw token is never stored: a database leak must not
  -- hand over usable sessions.
  token_hash text        NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX refresh_tokens_family ON refresh_tokens (family_id);
CREATE INDEX refresh_tokens_user   ON refresh_tokens (user_id);
-- Supports the periodic cleanup of expired rows.
CREATE INDEX refresh_tokens_expiry ON refresh_tokens (expires_at);

-- Down Migration
DROP TABLE IF EXISTS refresh_tokens;
