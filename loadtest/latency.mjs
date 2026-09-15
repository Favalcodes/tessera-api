#!/usr/bin/env node
/**
 * Resolve-to-client latency (PRD section 8).
 *
 *   node loadtest/latency.mjs [viewers]
 *
 * Connects N viewers and waits for rounds to crash, measuring the gap between
 * the server's own `crashedAt` timestamp and the moment each client's socket
 * receives the state carrying it. That gap is the whole broadcast path:
 * pg_notify, the gateway, socket.io, and the loopback network.
 *
 * Measured against the server's timestamp rather than the client's clock, so the
 * number does not quietly become a measure of clock skew.
 */
import { writeFileSync } from 'node:fs';
import { io } from 'socket.io-client';
import { percentile } from './lib.mjs';

const BASE = process.env.API_URL ?? 'http://localhost:3010';
const VIEWERS = Number(process.argv[2] ?? process.env.VIEWERS ?? 50);
const ROUNDS = Number(process.env.ROUNDS ?? 3);

const samples = [];
const seen = new Set();

function connectViewer(index) {
  return new Promise((resolve, reject) => {
    const socket = io(`${BASE}/live`, { transports: ['websocket'], forceNew: true });

    socket.on('connect_error', reject);
    socket.on('connect', () => resolve(socket));

    socket.on('round:state', (payload) => {
      const { round } = payload;
      if (round.status !== 'CRASHED' || !round.crashedAt) return;

      const key = `${index}:${round.id}`;
      if (seen.has(key)) return;
      seen.add(key);

      samples.push({
        roundId: round.id,
        viewer: index,
        latencyMs: Date.now() - new Date(round.crashedAt).getTime(),
      });
    });
  });
}

const sockets = await Promise.all(
  Array.from({ length: VIEWERS }, (_, index) => connectViewer(index)),
);
console.log(`${VIEWERS} viewers connected; watching ${ROUNDS} rounds crash…\n`);

const distinctRounds = () => new Set(samples.map((s) => s.roundId)).size;

const deadline = Date.now() + 5 * 60_000;
while (distinctRounds() < ROUNDS && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 250));
}

for (const socket of sockets) socket.disconnect();

if (!samples.length) {
  console.error('No crashes observed. Is the round engine running?');
  process.exit(1);
}

const latencies = samples.map((s) => s.latencyMs);
const summary = {
  recordedAt: new Date().toISOString(),
  viewers: VIEWERS,
  roundsObserved: distinctRounds(),
  broadcastsMeasured: samples.length,
  resolveToClientMs: {
    min: Math.min(...latencies),
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    max: Math.max(...latencies),
  },
};

console.log(`rounds observed      : ${summary.roundsObserved}`);
console.log(`broadcasts measured  : ${summary.broadcastsMeasured}`);
console.log(`\nresolve -> client latency (ms)`);
console.log(`  min ${summary.resolveToClientMs.min}`);
console.log(`  p50 ${summary.resolveToClientMs.p50}`);
console.log(`  p95 ${summary.resolveToClientMs.p95}`);
console.log(`  max ${summary.resolveToClientMs.max}`);

writeFileSync(
  new URL('./results/latency.json', import.meta.url),
  `${JSON.stringify(summary, null, 2)}\n`,
);
console.log('\nWritten to loadtest/results/latency.json');
