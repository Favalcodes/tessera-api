-- Up Migration
-- =============================================================================
-- Tessera core schema: users + double-entry ledger (ADR-005).
--
-- The guarantees this project claims live HERE, in the database, not in the
-- application. Application-level checks are a comment; a constraint is a promise.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS citext;

-- -----------------------------------------------------------------------------
-- users
-- -----------------------------------------------------------------------------
CREATE TABLE users (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email             citext      NOT NULL UNIQUE,
  display_name      text        NOT NULL CHECK (length(btrim(display_name)) BETWEEN 2 AND 40),
  password_hash     text        NOT NULL,
  role              text        NOT NULL DEFAULT 'user'   CHECK (role   IN ('user', 'admin')),
  -- `status` is the KYC/AML extension seam described in PRD 5.6. Today it only ever
  -- holds 'active'; AccountStatusGuard reads it so a real verification step has a
  -- place to live without touching the bet path.
  status            text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'pending_verification')),
  email_verified_at timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- accounts — the four account kinds of ADR-005
-- -----------------------------------------------------------------------------
CREATE TYPE account_kind AS ENUM ('MINT', 'WALLET', 'ESCROW', 'HOUSE');

CREATE TABLE accounts (
  id            uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          account_kind NOT NULL,
  owner_user_id uuid         REFERENCES users (id) ON DELETE RESTRICT,
  -- Human-readable stable identifier: 'SYSTEM:MINT', 'USER:<uuid>:WALLET'.
  key           text         NOT NULL UNIQUE,
  created_at    timestamptz  NOT NULL DEFAULT now(),

  -- A wallet always has an owner; a system account never does.
  CONSTRAINT accounts_owner_matches_kind CHECK (
    (kind =  'WALLET' AND owner_user_id IS NOT NULL) OR
    (kind <> 'WALLET' AND owner_user_id IS NULL)
  )
);

-- Exactly one wallet per user, and exactly one of each system account in the system.
CREATE UNIQUE INDEX accounts_one_wallet_per_user ON accounts (owner_user_id) WHERE kind = 'WALLET';
CREATE UNIQUE INDEX accounts_singleton_system    ON accounts (kind)          WHERE kind <> 'WALLET';

-- -----------------------------------------------------------------------------
-- transactions — the journal. One row per balance-affecting event.
-- -----------------------------------------------------------------------------
CREATE TABLE transactions (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  kind           text        NOT NULL,
  reference_type text,
  reference_id   uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT transactions_reference_paired CHECK (
    (reference_type IS NULL AND reference_id IS NULL) OR
    (reference_type IS NOT NULL AND reference_id IS NOT NULL)
  )
);

CREATE INDEX transactions_reference ON transactions (reference_type, reference_id);

-- -----------------------------------------------------------------------------
-- entries — the postings. Append-only. Signed amounts in MINOR UNITS.
--
-- `amount` is BIGINT minor units (100 = 1.00 credit). Never a float, never a
-- NUMERIC read into JS as a string-parsed decimal. A zero-amount posting is
-- meaningless, so it is forbidden outright.
-- -----------------------------------------------------------------------------
CREATE TABLE entries (
  id             bigserial   PRIMARY KEY,
  transaction_id uuid        NOT NULL REFERENCES transactions (id) ON DELETE RESTRICT,
  account_id     uuid        NOT NULL REFERENCES accounts (id)     ON DELETE RESTRICT,
  amount         bigint      NOT NULL CHECK (amount <> 0),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX entries_account_history ON entries (account_id, id DESC);
CREATE INDEX entries_transaction     ON entries (transaction_id);

-- -----------------------------------------------------------------------------
-- balances — a CACHE, never a source of truth.
--
-- Updated inside the same database transaction as the postings that move it, so
-- it can never be stale. `balance` must always equal the sum of that account's
-- entries; an automated test asserts exactly that.
-- -----------------------------------------------------------------------------
CREATE TABLE balances (
  account_id uuid        PRIMARY KEY REFERENCES accounts (id) ON DELETE RESTRICT,
  balance    bigint      NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- GUARANTEE 1 — every transaction's postings sum to exactly zero.
--
-- Deferred to COMMIT so a service can legally insert the debit leg and the credit
-- leg as separate statements. At commit, an unbalanced journal entry aborts the
-- whole transaction. This is what makes "credits cannot be conjured from nothing"
-- a property of the system rather than a property of the code that happens to be
-- calling it today.
-- =============================================================================
CREATE FUNCTION assert_transaction_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  total bigint;
  legs  int;
BEGIN
  SELECT COALESCE(sum(amount), 0), count(*)
    INTO total, legs
    FROM entries
   WHERE transaction_id = NEW.transaction_id;

  IF legs < 2 THEN
    RAISE EXCEPTION 'ledger transaction % has % posting(s); double-entry requires at least 2',
      NEW.transaction_id, legs
      USING ERRCODE = 'check_violation';
  END IF;

  IF total <> 0 THEN
    RAISE EXCEPTION 'ledger transaction % is unbalanced (postings sum to %)',
      NEW.transaction_id, total
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER entries_must_balance
  AFTER INSERT ON entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_transaction_balanced();

-- =============================================================================
-- GUARANTEE 2 — the ledger is append-only.
--
-- Enforced with a trigger rather than by revoking UPDATE/DELETE from a dedicated
-- role, so the guarantee holds identically in CI, in tests, and in a psql session,
-- with no role setup to forget. In a real deployment you would ALSO revoke the
-- grants; the trigger is the part that travels with the schema.
-- =============================================================================
CREATE FUNCTION forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER entries_append_only
  BEFORE UPDATE OR DELETE ON entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER transactions_append_only
  BEFORE UPDATE OR DELETE ON transactions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- -----------------------------------------------------------------------------
-- Every account gets its balances row at creation.
--
-- This removes the need for an upsert when posting. That matters more than it
-- looks: `INSERT ... ON CONFLICT DO UPDATE` fires BEFORE INSERT triggers against
-- the *proposed* row before it detects the conflict, so a negative delta would
-- trip the non-negative guard below even when the resolved balance is fine.
-- Guaranteeing the row exists means posting is a plain UPDATE, which has no such
-- interaction and takes the row lock we want anyway.
-- -----------------------------------------------------------------------------
CREATE FUNCTION create_balance_for_account() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO balances (account_id, balance) VALUES (NEW.id, 0);
  RETURN NULL;
END;
$$;

CREATE TRIGGER accounts_get_a_balance
  AFTER INSERT ON accounts
  FOR EACH ROW EXECUTE FUNCTION create_balance_for_account();

-- =============================================================================
-- GUARANTEE 3 — wallets and escrow can never go negative.
--
-- The last line of defence against an over-spend. Even if the balance check in
-- the application were removed entirely, an overdraft would abort the transaction.
-- MINT is negative by design (it is the source of all credits) and HOUSE is
-- legitimately negative whenever players are up, so both are exempt.
-- =============================================================================
CREATE FUNCTION assert_balance_non_negative() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  k account_kind;
BEGIN
  SELECT kind INTO k FROM accounts WHERE id = NEW.account_id;

  IF k IN ('WALLET', 'ESCROW') AND NEW.balance < 0 THEN
    RAISE EXCEPTION 'account % (%) may not hold a negative balance (attempted %)',
      NEW.account_id, k, NEW.balance
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER balances_non_negative
  BEFORE INSERT OR UPDATE ON balances
  FOR EACH ROW EXECUTE FUNCTION assert_balance_non_negative();

-- -----------------------------------------------------------------------------
-- Seed the three singleton system accounts with fixed ids so application code can
-- reference them as constants instead of looking them up on every request.
-- -----------------------------------------------------------------------------
-- The accounts_get_a_balance trigger creates each balances row at 0.
INSERT INTO accounts (id, kind, owner_user_id, key) VALUES
  ('00000000-0000-0000-0000-000000000001', 'MINT',   NULL, 'SYSTEM:MINT'),
  ('00000000-0000-0000-0000-000000000002', 'ESCROW', NULL, 'SYSTEM:ESCROW'),
  ('00000000-0000-0000-0000-000000000003', 'HOUSE',  NULL, 'SYSTEM:HOUSE');

-- Down Migration
DROP TRIGGER IF EXISTS balances_non_negative      ON balances;
DROP TRIGGER IF EXISTS accounts_get_a_balance      ON accounts;
DROP TRIGGER IF EXISTS transactions_append_only   ON transactions;
DROP TRIGGER IF EXISTS entries_append_only        ON entries;
DROP TRIGGER IF EXISTS entries_must_balance       ON entries;
DROP FUNCTION IF EXISTS assert_balance_non_negative();
DROP FUNCTION IF EXISTS create_balance_for_account();
DROP FUNCTION IF EXISTS forbid_mutation();
DROP FUNCTION IF EXISTS assert_transaction_balanced();
DROP TABLE IF EXISTS balances;
DROP TABLE IF EXISTS entries;
DROP TABLE IF EXISTS transactions;
DROP TABLE IF EXISTS accounts;
DROP TYPE  IF EXISTS account_kind;
DROP TABLE IF EXISTS users;
