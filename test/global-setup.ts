import { execFileSync } from 'node:child_process';
import { Client } from 'pg';

/**
 * Creates a dedicated test database and migrates it once per run.
 *
 * Tests run against real Postgres rather than a mock, because every guarantee
 * this project claims is enforced by Postgres — deferred constraint triggers,
 * row locks, append-only triggers. A mocked database would test the mock.
 */
const ADMIN_URL = process.env.TEST_ADMIN_URL ?? 'postgres://tessera@127.0.0.1:5434/tessera';
const TEST_DB = process.env.TEST_DB_NAME ?? 'tessera_test';

export default async function globalSetup(): Promise<void> {
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();

  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [TEST_DB]);
  if (exists.rowCount === 0) {
    await admin.query(`CREATE DATABASE ${TEST_DB}`);
  }
  await admin.end();

  const testUrl = new URL(ADMIN_URL);
  testUrl.pathname = `/${TEST_DB}`;

  execFileSync('pnpm', ['exec', 'node-pg-migrate', '-j', 'sql', '-m', 'migrations', 'up'], {
    env: { ...process.env, DATABASE_URL: testUrl.toString() },
    stdio: 'pipe',
  });

  process.env.DATABASE_URL = testUrl.toString();
}
