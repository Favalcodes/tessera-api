#!/usr/bin/env node
/**
 * The Phase 2 proof points, run over HTTP against a live API.
 *
 *   node loadtest/run.mjs
 *
 * Requires the API running with THROTTLE_ENABLED=false — otherwise the rate
 * limiter refuses the burst and the run measures the limiter rather than the
 * concurrency control.
 */
import { writeFileSync } from 'node:fs';
import {
  api,
  assertLedgerBalanced,
  check,
  heading,
  registerUser,
  summarise,
  uuid,
  waitForRound,
} from './lib.mjs';

const CONCURRENT_BETS = Number(process.env.CONCURRENT_BETS ?? 200);
const CONCURRENT_CASHOUTS = Number(process.env.CONCURRENT_CASHOUTS ?? 100);
const STAKE = 10_000; // 100.00
const GRANT = 100_000; // 1000.00
const AFFORDABLE = GRANT / STAKE;

const results = [];

/**
 * PRD 5.2: N concurrent bets against one account with funds for a fraction of
 * them. Exactly the affordable number must succeed — no over-spends, no lost
 * updates, and every refusal a clean 409 rather than a 500 from a constraint
 * violation reaching the database.
 */
async function overspendScenario() {
  heading(`Over-spend: ${CONCURRENT_BETS} concurrent bets, funds for ${AFFORDABLE}`);

  const round = await waitForRound(['OPEN']);
  const { accessToken, user } = await registerUser();

  const responses = await Promise.all(
    Array.from({ length: CONCURRENT_BETS }, () =>
      api(`/rounds/${round.id}/bets`, {
        method: 'POST',
        token: accessToken,
        body: { stakeMinor: STAKE, idempotencyKey: uuid() },
      }),
    ),
  );

  const created = responses.filter((r) => r.status === 201 || r.status === 200);
  const conflicts = responses.filter((r) => r.status === 409);
  const serverErrors = responses.filter((r) => r.status >= 500);

  check('bets accepted', created.length, AFFORDABLE);
  check('refused with 409 (insufficient funds)', conflicts.length, CONCURRENT_BETS - AFFORDABLE);
  check('server errors', serverErrors.length, 0);

  const balance = await api('/me/balance', { token: accessToken });
  check('final balance (minor units)', balance.body.balanceMinor, 0);

  const bets = await api(`/rounds/${round.id}/bets`, { token: accessToken });
  check('bet rows created', bets.body.length, AFFORDABLE);

  results.push(summarise('overspend', responses.map((r) => r.durationMs)));
  return { userId: user.id };
}

/**
 * The same idempotency key, sent many times at once. Exactly one bet must exist
 * afterwards, and the account must be debited exactly once.
 */
async function idempotencyScenario() {
  heading(`Idempotency: ${CONCURRENT_BETS} concurrent requests, one shared key`);

  const round = await waitForRound(['OPEN']);
  const { accessToken } = await registerUser();
  const sharedKey = uuid();

  const responses = await Promise.all(
    Array.from({ length: CONCURRENT_BETS }, () =>
      api(`/rounds/${round.id}/bets`, {
        method: 'POST',
        token: accessToken,
        body: { stakeMinor: STAKE, idempotencyKey: sharedKey },
      }),
    ),
  );

  const ok = responses.filter((r) => r.status === 201 || r.status === 200);
  const ids = new Set(ok.map((r) => r.body.id));

  check('requests answered successfully', ok.length, CONCURRENT_BETS);
  check('distinct bets created', ids.size, 1);
  check('server errors', responses.filter((r) => r.status >= 500).length, 0);

  const balance = await api('/me/balance', { token: accessToken });
  check('debited exactly once', balance.body.balanceMinor, GRANT - STAKE);

  results.push(summarise('idempotency', responses.map((r) => r.durationMs)));
}

/**
 * A cash-out storm on a single bet. Cash-out is idempotent, so every caller may
 * legitimately get an answer — but they must all describe the same settlement,
 * and the account must be credited once.
 */
async function cashOutScenario() {
  heading(`Cash-out storm: ${CONCURRENT_CASHOUTS} concurrent requests, one bet`);

  const round = await waitForRound(['OPEN']);
  const { accessToken } = await registerUser();

  const placed = await api(`/rounds/${round.id}/bets`, {
    method: 'POST',
    token: accessToken,
    body: { stakeMinor: STAKE, idempotencyKey: uuid() },
  });
  if (placed.status !== 201 && placed.status !== 200) {
    throw new Error(`could not place the bet: ${placed.status}`);
  }

  await waitForRound(['FLYING']);

  const responses = await Promise.all(
    Array.from({ length: CONCURRENT_CASHOUTS }, () =>
      api(`/rounds/bets/${placed.body.id}/cashout`, {
        method: 'POST',
        token: accessToken,
        body: { idempotencyKey: uuid() },
      }),
    ),
  );

  const paid = responses.filter((r) => (r.status === 200 || r.status === 201) && r.body?.payoutMinor !== null);
  const payouts = new Set(paid.map((r) => r.body.payoutMinor));
  const serverErrors = responses.filter((r) => r.status >= 500);

  // Either the whole burst landed before the crash, or the whole burst was too
  // late. Both are correct; what must never happen is more than one settlement.
  if (paid.length > 0) {
    check('distinct payout amounts', payouts.size, 1);
    const balance = await api('/me/balance', { token: accessToken });
    const payout = [...payouts][0];
    check('credited exactly once', balance.body.balanceMinor, GRANT - STAKE + payout);
  } else {
    console.log('  NOTE  the burst arrived after the crash; all refused, which is correct');
  }
  check('server errors', serverErrors.length, 0);

  results.push(summarise('cashout', responses.map((r) => r.durationMs)));
}

async function main() {
  const health = await api('/health');
  if (health.status !== 200) {
    console.error(`API is not reachable at ${process.env.API_URL ?? 'http://localhost:3010'}`);
    process.exit(1);
  }

  await overspendScenario();
  await idempotencyScenario();
  await cashOutScenario();

  heading('Ledger integrity');
  const ledger = await assertLedgerBalanced();
  console.log(`  PASS  global posting sum                        ${ledger.globalPostingSum}`);
  console.log(`  PASS  accounts drifting from their postings     ${ledger.driftingAccounts}`);
  console.log(`        credits in circulation                   ${ledger.creditsInCirculation}`);

  heading('Latency');
  console.table(results);

  const artefact = {
    recordedAt: new Date().toISOString(),
    node: process.version,
    concurrentBets: CONCURRENT_BETS,
    concurrentCashouts: CONCURRENT_CASHOUTS,
    scenarios: results,
    ledger,
    passed: process.exitCode !== 1,
  };

  const path = new URL('./results/latest.json', import.meta.url);
  writeFileSync(path, `${JSON.stringify(artefact, null, 2)}\n`);
  console.log(`\nWritten to loadtest/results/latest.json`);

  if (process.exitCode === 1) {
    console.error('\nFAILED — at least one guarantee did not hold.');
  }
}

await main();
