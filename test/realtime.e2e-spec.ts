import type { INestApplication } from '@nestjs/common';
import { ServerEvent, type RoundStatePayload, type PublicBetPayload, type WalletUpdatedPayload } from '@tessera/contracts';
import type { Kysely } from 'kysely';
import { randomUUID } from 'node:crypto';
import { io, type Socket } from 'socket.io-client';
import { AuthService } from '../src/auth/auth.service';
import type { DB } from '../src/database/database.types';
import { RoundsService } from '../src/rounds/rounds.service';
import { createRoundWithCrashPoint, engine, launchRound, setElapsed } from './helpers/round-fixtures';
import { createTestApp, resetDatabase, uniqueEmail } from './helpers/test-app';

/**
 * The real-time layer, over a genuine socket connection to a listening server.
 *
 * Events travel the full path they do in production: published inside the
 * database transaction that performed the write, delivered by Postgres
 * LISTEN/NOTIFY, translated by the gateway, and received by a real client.
 * Nothing here is stubbed.
 */
describe('Real-time layer', () => {
  let app: INestApplication;
  let db: Kysely<DB>;
  let rounds: RoundsService;
  let auth: AuthService;
  let url: string;
  const sockets: Socket[] = [];

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    db = ctx.db;
    rounds = app.get(RoundsService);
    auth = app.get(AuthService);

    await app.listen(0);
    const address = app.getHttpServer().address() as { port: number };
    url = `http://127.0.0.1:${address.port}/live`;
  });

  beforeEach(async () => {
    await resetDatabase(db);
  });

  afterEach(() => {
    while (sockets.length) sockets.pop()?.disconnect();
  });

  afterAll(async () => {
    await app.close();
  });

  function connect(token?: string): Socket {
    const socket = io(url, {
      transports: ['websocket'],
      forceNew: true,
      auth: token ? { token } : undefined,
    });
    sockets.push(socket);
    return socket;
  }

  /** Resolve on the first matching event, or reject on timeout. */
  function next<T>(socket: Socket, event: string, timeoutMs = 5_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), timeoutMs);
      socket.once(event, (payload: T) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });
  }

  async function makeUser() {
    return auth.register({
      email: uniqueEmail(),
      displayName: 'Ada',
      password: 'correct-horse-battery-staple',
    });
  }

  it('sends full round state on connect, not a delta', async () => {
    const round = await createRoundWithCrashPoint(db, 20_000);

    const socket = connect();
    const payload = await next<RoundStatePayload>(socket, ServerEvent.ROUND_STATE);

    expect(payload.round.id).toBe(round.id);
    expect(payload.round.status).toBe('OPEN');
    // Everything a client needs to render from scratch, so a late joiner and a
    // reconnecting client take the identical path.
    expect(payload.round.locksAt).toBeDefined();
    expect(payload.serverTime).toBeDefined();
  });

  it('lets an anonymous viewer watch without an account', async () => {
    await createRoundWithCrashPoint(db, 20_000);

    const socket = connect();
    const payload = await next<RoundStatePayload>(socket, ServerEvent.ROUND_STATE);

    expect(payload.round.status).toBe('OPEN');
  });

  it('broadcasts a lifecycle transition to every connected client', async () => {
    const round = await createRoundWithCrashPoint(db, 20_000, { bettingWindowMs: -1 });

    const a = connect();
    const b = connect();
    await Promise.all([
      next<RoundStatePayload>(a, ServerEvent.ROUND_STATE),
      next<RoundStatePayload>(b, ServerEvent.ROUND_STATE),
    ]);

    const both = Promise.all([
      next<RoundStatePayload>(a, ServerEvent.ROUND_STATE),
      next<RoundStatePayload>(b, ServerEvent.ROUND_STATE),
    ]);

    await engine(app).tick(); // OPEN -> LOCKED

    const [first, second] = await both;
    expect(first.round.status).toBe('LOCKED');
    expect(second.round.status).toBe('LOCKED');
    void round;
  });

  it('publishes a bet to the public feed without leaking who placed it', async () => {
    const round = await createRoundWithCrashPoint(db, 20_000);
    const { user } = await makeUser();

    const watcher = connect();
    await next<RoundStatePayload>(watcher, ServerEvent.ROUND_STATE);

    const placed = next<PublicBetPayload>(watcher, ServerEvent.BET_PLACED);
    await rounds.placeBet({
      userId: user.id,
      roundId: round.id,
      stakeMinor: 5_000,
      idempotencyKey: randomUUID(),
    });

    const payload = await placed;
    expect(payload.displayName).toBe('Ada');
    expect(payload.stake).toBe('50.00');
    // The public feed carries no user id and no balance.
    expect(JSON.stringify(payload)).not.toContain(user.id);
    expect(payload).not.toHaveProperty('balanceMinor');
  });

  it('sends a balance update only to the account it belongs to', async () => {
    const round = await createRoundWithCrashPoint(db, 20_000);
    const mine = await makeUser();
    const theirs = await makeUser();

    const myServer = connect(mine.accessToken);
    const theirServer = connect(theirs.accessToken);
    await Promise.all([
      next<RoundStatePayload>(myServer, ServerEvent.ROUND_STATE),
      next<RoundStatePayload>(theirServer, ServerEvent.ROUND_STATE),
    ]);

    let leaked = false;
    theirServer.on(ServerEvent.WALLET_UPDATED, () => {
      leaked = true;
    });

    const updated = next<WalletUpdatedPayload>(myServer, ServerEvent.WALLET_UPDATED);
    await rounds.placeBet({
      userId: mine.user.id,
      roundId: round.id,
      stakeMinor: 5_000,
      idempotencyKey: randomUUID(),
    });

    const payload = await updated;
    expect(payload.balance).toBe('950.00');

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(leaked).toBe(false);
  });

  it('announces a cash-out with the multiplier it settled at', async () => {
    const round = await createRoundWithCrashPoint(db, 500_000);
    const { user } = await makeUser();
    const bet = await rounds.placeBet({
      userId: user.id,
      roundId: round.id,
      stakeMinor: 10_000,
      idempotencyKey: randomUUID(),
    });
    await launchRound(db, round.id);
    await setElapsed(db, round.id, 7_000);

    const watcher = connect();
    await next<RoundStatePayload>(watcher, ServerEvent.ROUND_STATE);

    const cashedOut = next<PublicBetPayload>(watcher, ServerEvent.BET_CASHED_OUT);
    const settled = await rounds.cashOut({ userId: user.id, betId: bet.id });

    const payload = await cashedOut;
    expect(payload.cashoutMultiplierBp).toBe(settled.cashoutMultiplierBp);
    expect(payload.payout).toBe(settled.payout);
  });

  it('answers a ping with server time, so a client can correct its clock', async () => {
    const socket = connect();
    await next<RoundStatePayload>(socket, ServerEvent.ROUND_STATE).catch(() => undefined);

    const before = Date.now();
    const serverTime = await socket.emitWithAck('ping', before);
    const after = Date.now();

    expect(typeof serverTime).toBe('number');
    // Server time sits inside the round trip, which is what makes the offset
    // calculation meaningful.
    expect(serverTime).toBeGreaterThanOrEqual(before - 1_000);
    expect(serverTime).toBeLessThanOrEqual(after + 1_000);
  });

  it('gives a reconnecting client the current round, not the one it left', async () => {
    const first = await createRoundWithCrashPoint(db, 20_000, { bettingWindowMs: -1 });

    const socket = connect();
    const initial = await next<RoundStatePayload>(socket, ServerEvent.ROUND_STATE);
    expect(initial.round.id).toBe(first.id);

    socket.disconnect();

    // While it was away, that round finished and another began.
    await engine(app).tick();
    await engine(app).tick();
    await setElapsed(db, first.id, 10 * 60 * 1000);
    await engine(app).tick();
    const second = await createRoundWithCrashPoint(db, 30_000);

    const rejoined = connect();
    const resumed = await next<RoundStatePayload>(rejoined, ServerEvent.ROUND_STATE);

    // Resynced against current state rather than replaying what it missed.
    expect(resumed.round.id).toBe(second.id);
  });
});
