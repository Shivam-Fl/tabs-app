import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';

import type { Database } from './client';

/**
 * Applies the generated migration list to whichever database is configured, behind a lock,
 * and is safe to call on every boot.
 */

export interface Migration {
  /** The file's tag — 0000, 0001 — which orders the list and is what is recorded. */
  tag: string;
  sql: string;
}

const LOCK_KEY = 'tabs:migrations';
const JOURNAL = join(process.cwd(), 'drizzle', 'meta', '_journal.json');
const BREAKPOINT = '--> statement-breakpoint';

/** drizzle-kit separates statements with a breakpoint marker; neither backend takes them all at once. */
export function statementsOf(file: string): string[] {
  return file
    .split(BREAKPOINT)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

interface JournalEntry {
  tag: string;
}

/**
 * The committed migration list, read from disk. It has to be committed: ci-verify never runs
 * db:generate, and an uncommitted list means an empty database with no tables and a sign-up
 * that 500s.
 */
export function loadMigrations(directory = join(process.cwd(), 'drizzle')): Migration[] {
  const journal = JSON.parse(readFileSync(JOURNAL, 'utf8')) as { entries: JournalEntry[] };
  const tags = journal.entries.map((entry) => entry.tag);

  const migrations = readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .map((name) => ({
      name,
      tag: name.replace(/\.sql$/, ''),
      sql: readFileSync(join(directory, name), 'utf8'),
    }));

  // The journal is the order; a .sql file the journal does not name was never generated.
  const byTag = new Map(migrations.map((migration) => [migration.tag, migration]));
  return tags.map((tag) => {
    const migration = byTag.get(tag);
    if (!migration) throw new Error(`tabs: migration ${tag} is in the journal but ${tag}_*.sql is missing`);
    return { tag, sql: migration.sql };
  });
}

/**
 * Applies every migration the database has not recorded yet, in order, inside one
 * transaction, behind an advisory lock so two concurrent cold starts cannot apply one
 * migration twice.
 *
 * The applied set is read INSIDE the lock. Reading it before taking the lock is the specific
 * bug that lets two cold starts each decide a migration is pending.
 */
export async function migrate(db: Database, migrations: Migration[]): Promise<number> {
  // migrate.ts's own bookkeeping, created here rather than in schema.ts: a first boot on an
  // empty database has no such table to read, and the read is what would throw.
  await db.execute(sql`CREATE TABLE IF NOT EXISTS tabs_migrations (
    "tag" text PRIMARY KEY,
    "applied_at" timestamptz NOT NULL DEFAULT now()
  )`);

  await db.execute(sql`SELECT pg_advisory_lock(hashtext(${LOCK_KEY}))`);
  try {
    const applied = new Set(
      (await db.execute<{ tag: string }>(sql`SELECT "tag" FROM tabs_migrations`)).rows.map((row) => row.tag),
    );
    const pending = migrations.filter((migration) => !applied.has(migration.tag));
    if (pending.length === 0) return 0;

    for (const migration of pending) {
      await db.transaction(async (tx) => {
        // Split on drizzle-kit's statement breakpoints: PGlite's query and the Neon Pool's
        // both take one statement at a time, and a whole file sent as one string is how a
        // migration that worked in development fails on boot.
        for (const statement of statementsOf(migration.sql)) {
          await tx.execute(sql.raw(statement));
        }
        await tx.execute(sql`INSERT INTO tabs_migrations ("tag") VALUES (${migration.tag})`);
      });
    }
    return pending.length;
  } finally {
    await db.execute(sql`SELECT pg_advisory_unlock(hashtext(${LOCK_KEY}))`);
  }
}