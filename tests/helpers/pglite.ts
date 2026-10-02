import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';

import { createDatabase, setDatabase, type Database } from '@/db/client';
import { loadMigrations, migrate } from '@/db/migrate';

/**
 * The ONLY sanctioned way a test reaches the database.
 *
 * A fresh in-memory PGlite per test file, wrapped with the real createDatabase() and
 * installed on the same globalThis slot src/db/client.ts uses, BEFORE any route or action
 * module is imported. No mocking of any src/db module, and no network and no real Postgres:
 * a test that needs either is a bug in the test.
 *
 * Import this helper before importing anything that reaches the database.
 */

let active: PGlite | undefined;

export async function useTestDatabase(): Promise<Database> {
  active = new PGlite();
  const db = createDatabase(active);
  setDatabase(db);
  await migrate(db, loadMigrations());
  return db;
}

export async function closeTestDatabase(): Promise<void> {
  await active?.close();
  active = undefined;
}

/** Empties the tables a test wrote to, without dropping the schema. */
export async function resetRows(db: Database): Promise<void> {
  await db.execute(sql`TRUNCATE login_attempts, sessions, users RESTART IDENTITY CASCADE`);
}