import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { closeTestDatabase, useTestDatabase } from '../helpers/pglite';
import { createDatabase, setDatabase } from '@/db/client';
import { loadMigrations, migrate, statementsOf, type Migration } from '@/db/migrate';

afterAll(async () => {
  await closeTestDatabase();
});

async function tableNames(db: Awaited<ReturnType<typeof useTestDatabase>>): Promise<string[]> {
  const rows = await db.execute<{ table_name: string }>(
    sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
  );
  return rows.rows.map((row) => row.table_name).sort();
}

describe('the committed migration list', () => {
  it('applies to an empty in-process PGlite, creating the three tables and their indexes', async () => {
    const db = await useTestDatabase();

    expect(await tableNames(db)).toEqual(['login_attempts', 'sessions', 'tabs_migrations', 'users']);

    const indexes = await db.execute<{ indexname: string }>(
      sql`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`,
    );
    const names = indexes.rows.map((row) => row.indexname);
    expect(names).toContain('sessions_token_hash_idx');
    expect(names).toContain('sessions_user_id_idx');
    expect(names).toContain('login_attempts_key_created_idx');
    expect(names).toContain('login_attempts_source_created_idx');
  });

  it('migrate() creates its own bookkeeping table, so a first boot on an empty database does not throw', async () => {
    // This is the case that read-before-create got wrong: with no tabs_migrations table, the
    // read of the applied set is what throws, before any product table exists.
    const fresh = await useTestDatabase();
    expect(await migrate(fresh, [])).toBe(0);
    expect(await tableNames(fresh)).toContain('tabs_migrations');
  });

  it('re-applying is a no-op that writes nothing', async () => {
    const db = await useTestDatabase();
    const before = await db.execute(sql`SELECT "tag", "applied_at" FROM tabs_migrations ORDER BY "tag"`);

    expect(await migrate(db, loadMigrations())).toBe(0);

    const after = await db.execute(sql`SELECT "tag", "applied_at" FROM tabs_migrations ORDER BY "tag"`);
    expect(after.rows).toEqual(before.rows);
  });

  it('holds the advisory lock for the whole critical section, and releases it on the way out', async () => {
    const db = await useTestDatabase();

    // This migration refuses to apply unless the advisory lock is registered while it runs.
    // If migrate() read the applied set before taking the lock — or took it after applying —
    // this raises and the test fails.
    const observing: Migration = {
      tag: '9000_observes_the_lock',
      sql: `DO $tabs$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory') THEN
    RAISE EXCEPTION 'the advisory lock was not held while this migration ran';
  END IF;
END
$tabs$;`,
    };

    expect(await migrate(db, [observing])).toBe(1);

    // Released on the way out: a fresh boot can take it.
    const free = await db.execute<{ locked: boolean }>(
      sql`SELECT pg_try_advisory_lock(hashtext('tabs:migrations')) AS locked`,
    );
    expect(free.rows[0]?.locked).toBe(true);
    await db.execute(sql`SELECT pg_advisory_unlock(hashtext('tabs:migrations'))`);
  });

  it('a migration that throws releases the lock in its finally', async () => {
    const db = await useTestDatabase();

    await expect(migrate(db, [{ tag: '9999_broken', sql: 'CREATE TABLE ok (id int); SELECT this_does_not_exist();' }])).rejects.toThrow();

    // If the finally had not run, this would be false and the next cold start would deadlock.
    const free = await db.execute<{ locked: boolean }>(sql`SELECT pg_try_advisory_lock(hashtext('tabs:migrations')) AS locked`);
    expect(free.rows[0]?.locked).toBe(true);
    await db.execute(sql`SELECT pg_advisory_unlock(hashtext('tabs:migrations'))`);

    // And the migration's own table rolled back with it.
    expect(await tableNames(db)).not.toContain('ok');
  });
});

describe('the migration files themselves', () => {
  it('splits on drizzle-kit statement breakpoints, because neither backend takes a whole file at once', () => {
    expect(statementsOf('CREATE TABLE a (id int);--> statement-breakpoint\nCREATE INDEX b ON a (id);')).toEqual([
      'CREATE TABLE a (id int);',
      'CREATE INDEX b ON a (id);',
    ]);
  });

  it('is committed, because ci-verify never runs db:generate', () => {
    const migrations = loadMigrations();
    expect(migrations.length).toBeGreaterThan(0);
    expect(migrations[0]?.sql).toContain('CREATE TABLE "users"');
  });
});

describe('the client seam', () => {
  it('createDatabase takes the driver as an argument, so no test has to mock this file', async () => {
    const db = await useTestDatabase();
    expect(typeof db.select).toBe('function');
    expect(typeof createDatabase).toBe('function');
    expect(typeof setDatabase).toBe('function');
  });
});