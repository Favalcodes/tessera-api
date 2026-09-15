/**
 * Minimal HTTP load harness.
 *
 * Plain Node against the running API — no k6, no Artillery, nothing to install.
 * That is a deliberate constraint of this environment rather than a preference:
 * the scenarios below are the deliverable, and they translate to k6 directly if
 * you would rather run them there.
 *
 * What makes these results worth quoting is not the request rate. It is that
 * each scenario asserts an exact outcome — *exactly* the affordable number of
 * bets succeed, *exactly* one payout — and then checks that the ledger still
 * balances. "No over-spends" is a weak claim on its own; an implementation
 * could refuse the right number of requests and still corrupt the books.
 */

const BASE = process.env.API_URL ?? 'http://localhost:3010';

export async function api(path, { method = 'GET', body, token } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  const started = performance.now();
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const durationMs = performance.now() - started;

  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;

  return { status: response.status, body: parsed, durationMs };
}

export async function registerUser() {
  const email = `load-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const { status, body } = await api('/auth/register', {
    method: 'POST',
    body: { email, displayName: 'Load', password: 'correct-horse-battery-staple' },
  });
  if (status !== 201) throw new Error(`register failed: ${status} ${JSON.stringify(body)}`);
  return body;
}

export const uuid = () => crypto.randomUUID();

/** Poll until the current round reaches one of `statuses`. */
export async function waitForRound(statuses, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const { status, body } = await api('/rounds/current');
    if (status === 200 && statuses.includes(body.status)) return body;
    await new Promise((r) => setTimeout(r, 100));
  }

  throw new Error(`timed out waiting for a round in ${statuses.join('/')}`);
}

/** The assertion every scenario ends with. */
export async function assertLedgerBalanced() {
  const { status, body } = await api('/health/ledger');
  const detail = body?.info?.ledger ?? body?.details?.ledger ?? {};

  const ok = status === 200 && detail.globalPostingSum === 0 && detail.driftingAccounts === 0;
  if (!ok) {
    throw new Error(`LEDGER INTEGRITY FAILURE: ${JSON.stringify(body)}`);
  }

  return detail;
}

export function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}

export function summarise(name, durations) {
  return {
    scenario: name,
    requests: durations.length,
    p50Ms: Number(percentile(durations, 50).toFixed(1)),
    p95Ms: Number(percentile(durations, 95).toFixed(1)),
    maxMs: Number(Math.max(...durations).toFixed(1)),
  };
}

export function heading(text) {
  console.log(`\n${'─'.repeat(72)}\n${text}\n${'─'.repeat(72)}`);
}

export function check(label, actual, expected) {
  const pass = actual === expected;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label.padEnd(46)} ${actual} (expected ${expected})`);
  if (!pass) process.exitCode = 1;
  return pass;
}
