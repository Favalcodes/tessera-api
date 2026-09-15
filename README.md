# Tessera — API

**A real-time ledger and settlement engine.**

> Tessera is a **simulated** betting platform. There is no real money in it: no deposits,
> no withdrawals, no cash value, no payment integration of any kind. Balances are virtual
> credits issued by the system itself. It exists to demonstrate ledger integrity,
> concurrency safety, and real-time server-authoritative state — not to be a gambling
> product.

---

## What this is actually about

Three claims, each enforced rather than asserted:

1. **Credits cannot be created or destroyed.** Every balance change is a double-entry
   transaction whose postings sum to zero, checked by a deferred constraint trigger in
   Postgres at commit. A balance is never written directly.
2. **Concurrent bets cannot over-spend an account.** Row-level locking makes
   check-then-debit atomic. *(Phase 2 — in progress.)*
3. **Outcomes are fixed before any bet is placed, and anyone can verify it.**
   *(Phase 4 — not started.)*

The interesting part is that these are database guarantees, not application conventions.
If every line of application code were deleted, a raw `psql` session still could not
write an unbalanced transaction, edit a historical posting, or drive a wallet negative.

---

## Status

| Phase | Scope | State |
|---|---|---|
| 0 | Repo, database, CI, health checks | **Done** |
| 1 | Double-entry ledger, auth, invariant tests | **Done** |
| 2 | Round engine, atomic betting, cash-out, load tests | Next |
| 3 | WebSocket layer, live UI | Not started |
| 4 | Hash-chain provable fairness, admin dashboard | Not started |
| 5 | Docs, demo, deploy | Not started |

42 tests passing.

---

## Running it

Requires Node 22+, pnpm, and a local PostgreSQL 16/17 installation. No Docker.

```bash
pnpm install
cp .env.example .env

pnpm db:up        # starts a dedicated user-owned cluster on 127.0.0.1:5434
pnpm migrate
pnpm start:dev    # http://localhost:3010, API docs at /docs
pnpm test
```

`pnpm db:up` runs its own Postgres cluster under `~/.tessera`, separate from any system
Postgres service — so it needs no sudo, touches nothing global, and `pnpm db:reset`
throws it away and rebuilds from scratch. Set `PGBIN` if your Postgres binaries are not
at `/Library/PostgreSQL/17/bin`.

| Script | Does |
|---|---|
| `pnpm db:up` / `db:down` / `db:status` | Cluster lifecycle |
| `pnpm db:psql` | Open a shell on the dev database |
| `pnpm db:reset` | Destroy, recreate and re-migrate |
| `pnpm typecheck` / `lint` / `test` / `build` | What CI runs |

---

## The ledger

Four account kinds. Every credit in existence traces back to `MINT`.

| Account | Role |
|---|---|
| `SYSTEM:MINT` | The sole source of credits. Signup grants debit it, so its balance is the negative of everything ever issued. |
| `USER:<id>:WALLET` | A player's spendable balance. |
| `SYSTEM:ESCROW` | Holds stakes for the duration of a round. |
| `SYSTEM:HOUSE` | Absorbs losses, funds winnings. |

```
signup grant        MINT   −1000  →  WALLET +1000
place bet           WALLET −stake →  ESCROW +stake
cash out at m       ESCROW −stake →  WALLET +stake
                    HOUSE  −stake*(m−1) → WALLET +stake*(m−1)
crash, no cash-out  ESCROW −stake →  HOUSE  +stake
```

**Amounts are integer minor units.** 100 units = 1 credit. No floats touch a balance, and
the `Money` type is branded so a bare `number` will not compile where an amount is
expected. Multipliers are basis points (`10_000` = 1.00x). Payouts floor, always in the
house's favour, so repeated payouts cannot leak fractions upward.

### The guarantees, and where they live

All three are in [`migrations/1757900000000_initial-ledger.sql`](migrations/1757900000000_initial-ledger.sql):

- **Transactions must balance** — a deferred constraint trigger rejects, at commit, any
  transaction whose postings do not sum to zero or that has fewer than two legs.
  Deferred so a service can insert the debit and credit legs as separate statements.
- **The ledger is append-only** — `UPDATE` and `DELETE` on `entries` and `transactions`
  raise. Implemented as a trigger rather than a `REVOKE` so the guarantee travels with
  the schema into CI and tests with no role setup to forget.
- **Wallets and escrow cannot go negative** — the last line of defence against an
  over-spend, independent of any application check. `MINT` and `HOUSE` are exempt:
  `MINT` is negative by construction, and `HOUSE` is legitimately negative when players
  are up.

`GET /health/ledger` is a Terminus health indicator reporting the global posting sum and
any account whose cached balance has drifted from the sum of its postings. It is asserted
at the end of every CI run, and will be asserted at the end of every Phase 2 load test.

### A subtlety worth recording

The first implementation updated balances with `INSERT ... ON CONFLICT DO UPDATE`. That
is quietly incompatible with a `BEFORE INSERT` non-negative trigger: Postgres fires the
insert trigger against the *proposed* row before it detects the conflict, so a posting of
`−1` tripped the guard even though the resolved balance would have been `0`. Every
account now gets its balances row by trigger at creation, which makes posting a plain
`UPDATE` — no upsert, no interaction, and it takes the row lock we want anyway.

---

## Auth

Email + password (argon2id, OWASP baseline parameters), access JWT plus refresh token
with **rotation and reuse detection**. Every login starts a token family; each refresh
rotates and marks the old token spent. Presenting a spent token means theft-and-replay or
a client racing itself, and both get the same answer: revoke the whole family.

The revocation commits before the error is raised. That ordering is the entire point — an
earlier version revoked inside the transaction and then threw, which rolled the revocation
back and left the compromised family live while the logs claimed otherwise.

Refresh tokens are stored as a SHA-256 digest, never in the clear. Plain SHA-256 rather
than argon2 is correct *here* specifically: the token is 128 bits of server-generated
randomness, so there is no dictionary to attack and a slow hash would only add latency to
every refresh.

Login timing is constant whether or not the email exists — an unknown address is verified
against a precomputed dummy hash, so response time does not enumerate the user table.

### The KYC seam

There is no KYC, because there is no real money. But `AccountStatusGuard` sits on the path
a bet will take and reads a `users.status` column that already has a
`pending_verification` state. A real identity check has a decided, wired, tested place to
live. The bet path would not change.

---

## Endpoints

| Method | Path | Notes |
|---|---|---|
| `POST` | `/auth/register` | Creates user, wallet and opening grant in one transaction |
| `POST` | `/auth/login` | |
| `POST` | `/auth/refresh` | Rotates; detects reuse |
| `POST` | `/auth/logout` | Revokes the token family |
| `GET` | `/me/balance` | Derived from the ledger |
| `GET` | `/me/ledger` | Keyset-paginated posting history |
| `GET` | `/me` | The authenticated account |
| `GET` | `/health` · `/health/ready` · `/health/ledger` | Liveness, readiness, integrity |

Authentication is on by default — routes opt out with `@Public()`, so a new endpoint
cannot be left unprotected by forgetting a decorator.

---

## Layout

Conventional NestJS: feature modules at `src/` root, cross-cutting concerns in `common/`.

```
migrations/            Hand-written SQL. Owns every constraint and trigger.
scripts/db.sh          Local cluster lifecycle.
packages/contracts/    Shared with tessera-web over a git dependency.
src/
  common/
    decorators/        @Public, @Roles, @CurrentUser
    filters/           Domain error -> HTTP mapping
    guards/            Rate limiting
    types/             Authenticated request shape
    value-objects/     Money, BasisPoints
  config/              Env schema — the process refuses to boot on bad config
  database/            Kysely wiring, schema types, BIGINT parsing
  ledger/              The only code permitted to write postings
  auth/                Registration, login, rotation, guards
  users/               Users table, balance, history
  health/              Terminus checks incl. the ledger invariant
test/                  e2e and property-based tests against real Postgres
```

Tests run against real Postgres, never a mock, because every guarantee here is enforced by
Postgres. A mocked database would be testing the mock.

---

## The shared contract

`packages/contracts` is the single definition of everything both repos must agree on:
wire types, and the arithmetic. `formatMinorUnits` and `applyBasisPoints` live there, so
the payout the client displays and the payout the server settles are the *same function*
rather than two implementations that happen to agree today.

The API consumes it through a pnpm workspace. `tessera-web` installs it from git — no
registry, no publish step:

```bash
pnpm add "github:<owner>/tessera-api#path:/packages/contracts"
```

The package is deliberately dependency-free and framework-free. pnpm runs its `prepare`
script on the consumer's machine, so anything it needs to build, the consumer pays for;
and it has to compile unchanged in both a browser and Node, because it does both.

Phase 2's multiplier curve and Phase 4's fairness verifier belong here for the same
reason: the client interpolates the climbing multiplier locally from a broadcast
timestamp, and a curve that differs from the server's by a rounding step would show a
player a number the server will not pay.

---

## Decisions

**Why a crash-style game.** It is the only candidate with two concurrency-critical write
paths rather than one. Bet placement is the path every such project shows; cash-out is the
harder one, because it races the round resolver — a double cash-out or a cash-out landing
after the crash is a real correctness bug a naive implementation will have.

**Why own the WebSocket layer.** "A managed service pushed it to the client" is a thin
answer. Fanning out from a single authoritative round engine, having clients interpolate
the multiplier locally from a broadcast timestamp, and resyncing reconnects against round
state rather than replaying missed ticks — that is the part worth being able to explain.

**Why full double-entry rather than signed single-entry.** A `type` column with a sign
lets credits be created from nothing with nothing to detect it. Real double-entry gives a
global invariant — every posting in the system sums to zero — checkable in one query.

**Why the server derives the multiplier.** A client-supplied multiplier is a request to be
paid an arbitrary amount. Deriving it from the server's own clock also means a lagging
client cannot be paid for a cash-out that arrived after the crash.

**Why Kysely and hand-written SQL rather than Prisma.** The constraints above are the
product. Prisma's schema language cannot express a deferred constraint trigger, an
append-only guard, or a conditional non-negative check, so they would have been unmanaged
raw SQL regardless. Kysely keeps full type safety while `SELECT ... FOR UPDATE` and
advisory locks — both load-bearing in Phase 2 — stay first-class and visible.

---

## Licence

MIT.
