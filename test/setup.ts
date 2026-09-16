/**
 * Per-file test environment. Secrets here are fixed, obviously fake, and long
 * enough to satisfy the schema's minimum length.
 */
const testUrl = new URL(process.env.TEST_ADMIN_URL ?? 'postgres://tessera@127.0.0.1:5434/tessera');
testUrl.pathname = `/${process.env.TEST_DB_NAME ?? 'tessera_test'}`;

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = testUrl.toString();
process.env.JWT_ACCESS_SECRET = 'test-access-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
process.env.JWT_ACCESS_TTL = '900';
process.env.JWT_REFRESH_TTL = '2592000';
process.env.SIGNUP_GRANT_MINOR = '100000';
process.env.LOG_LEVEL = 'fatal';
process.env.PORT = '3001';
process.env.THROTTLE_ENABLED = 'false';
// Large enough that the concurrency specs create genuine contention. At the
// default of 10, 40 "simultaneous" requests queue behind the pool and mostly
// run in sequence — which makes the race tests pass for the wrong reason.
process.env.DATABASE_POOL_MAX = '40';
// No pause between rounds in tests: specs drive the engine explicitly, and a
// real intermission would just make openRoundIfDue return null mid-assertion.
process.env.ROUND_INTERMISSION_MS = '0';

jest.setTimeout(30_000);
