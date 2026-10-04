import { sql } from 'drizzle-orm';
import { Pool } from '@neondatabase/serverless';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { closeTestDatabase, useTestDatabase } from '../helpers/pglite';
import { createDatabase, isPgliteSession, setDatabase, withPinnedSession } from '@/db/client';
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
  it('applies to an empty in-process PGlite, creating every table and index the schema declares', async () => {
    const db = await useTestDatabase();

    // 0000 stands up accounts and sign-in; 0001 adds the groups, the memberships and the feed;
    // 0003 adds the expenses, their payer/share/rule rows, and the feed's subject/detail;
    // 0004 adds the payments a group settles up with.
    expect(await tableNames(db)).toEqual([
      'activity',
      'expense_payer',
      'expense_share',
      'expense_split_input',
      'expenses',
      'groups',
      'login_attempts',
      'members',
      'payments',
      'sessions',
      'tabs_migrations',
      'users',
    ]);

    const indexes = await db.execute<{ indexname: string }>(
      sql`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`,
    );
    const names = indexes.rows.map((row) => row.indexname);
    expect(names).toContain('sessions_token_hash_idx');
    expect(names).toContain('sessions_user_id_idx');
    expect(names).toContain('login_attempts_key_created_idx');
    expect(names).toContain('login_attempts_source_created_idx');

    // Migration 0001. The two partial unique indexes are the group's two invariants — one
    // active membership per person, one owner per group — and they are only indexes if they
    // are here.
    expect(names).toContain('members_group_user_active_idx');
    expect(names).toContain('members_group_owner_idx');
    expect(names).toContain('members_user_id_idx');
    expect(names).toContain('activity_group_created_idx');
    expect(names).toContain('activity_member_created_idx');

    // Migration 0003. The date index is what makes the list's newest-first read an index scan
    // rather than a sort of every expense in the group (TR-18), and the description index is
    // what the search of piece 8 will use.
    expect(names).toContain('expenses_group_date_idx');
    expect(names).toContain('expenses_description_idx');

    // Migration 0004. The payments list is read newest-first per group, which is the same index
    // shape 0003 gave the expense list (TR-18).
    expect(names).toContain('payments_group_created_idx');
  });

  it('creates the expense enums with exactly the values the schema and the form offer', async () => {
    const db = await useTestDatabase();

    const types = await db.execute<{ typname: string }>(
      sql`SELECT typname FROM pg_type WHERE typtype = 'e' ORDER BY typname`,
    );
    expect(types.rows.map((row) => row.typname)).toContain('expense_split_type');
    expect(types.rows.map((row) => row.typname)).toContain('expense_category');

    // The labels are the contract the form's local option lists and the action's validation are
    // both written against, so a migration that dropped one would make a checked radio
    // unrepresentable in the database rather than merely unlisted.
    const labels = await db.execute<{ enumlabel: string }>(
      sql`SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
          WHERE t.typname = 'expense_split_type' ORDER BY e.enumsortorder`,
    );
    expect(labels.rows.map((row) => row.enumlabel)).toEqual(['equal', 'exact', 'percentage', 'shares']);

    const categories = await db.execute<{ enumlabel: string }>(
      sql`SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
          WHERE t.typname = 'expense_category' ORDER BY e.enumsortorder`,
    );
    expect(categories.rows.map((row) => row.enumlabel)).toEqual([
      'food',
      'travel',
      'rent',
      'utilities',
      'shopping',
      'entertainment',
      'other',
    ]);
  });

  it('adds subject_type, subject_id and detail to the feed the expense activity entry writes into', async () => {
    const db = await useTestDatabase();

    const columns = await db.execute<{ column_name: string; data_type: string }>(
      sql`SELECT column_name, data_type FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'activity'`,
    );
    const byName = new Map(columns.rows.map((row) => [row.column_name, row.data_type]));

    expect(byName.get('subject_type')).toBe('text');
    expect(byName.get('subject_id')).toBe('uuid');
    expect(byName.get('detail')).toBe('jsonb');
  });

  it('predicates the active-membership index on removed_at, exactly', async () => {
    const db = await useTestDatabase();

    const result = await db.execute<{ indexdef: string }>(
      sql`SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'members_group_user_active_idx'`,
    );
    const indexdef = result.rows[0]?.indexdef ?? '';

    /**
     * Compared on the normalised predicate rather than on the whole `indexdef`, whose spacing
     * and parenthesisation are the server's business.
     *
     * The `removed_at IS NULL` clause is what the whole index turns on: without it, the row a
     * person leaves behind still occupies their `(group_id, user_id)` slot, so rejoining the
     * group they left would fail on a duplicate key. And without `user_id IS NOT NULL`, two
     * placeholders in one group — both with no account yet — would collide.
     */
    const predicate = indexdef.slice(indexdef.indexOf('WHERE') + 'WHERE'.length);
    expect(predicate.replace(/[()]/g, '').trim()).toBe('user_id IS NOT NULL AND removed_at IS NULL');
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

    // The groups migration is a second generated file rather than an edit to the first: 0000
    // may already be applied somewhere, and migrate() applies each tag exactly once.
    const groups = migrations.find((migration) => migration.tag.includes('groups'));
    expect(groups, 'no committed migration creates the groups tables').toBeTruthy();
    expect(groups?.sql).toContain('CREATE TABLE "groups"');
    expect(groups?.sql).toContain('CREATE TABLE "members"');
    expect(groups?.sql).toContain('CREATE TABLE "activity"');
    expect(groups?.sql).toContain('CREATE TYPE "public"."group_type"');

    // 0003 is generator output too, and for a reason of its own: a hand-edited file that lost
    // its statement-breakpoint markers would apply on PGlite — which takes a multi-statement
    // string — and fail on Neon, which does not.
    const expenses = migrations.find((migration) => migration.tag.includes('expenses'));
    expect(expenses, 'no committed migration creates the expense tables').toBeTruthy();
    expect(expenses?.sql).toContain('CREATE TABLE "expenses"');
    expect(expenses?.sql).toContain('CREATE TABLE "expense_payer"');
    expect(expenses?.sql).toContain('CREATE TABLE "expense_share"');
    expect(expenses?.sql).toContain('CREATE TABLE "expense_split_input"');
    expect(expenses?.sql).toContain('CREATE TYPE "public"."expense_split_type"');
    expect(expenses?.sql).toContain('CREATE TYPE "public"."expense_category"');
    expect(expenses?.sql).toContain('ADD COLUMN "subject_type"');
    expect(expenses?.sql).toContain('ADD COLUMN "subject_id"');
    expect(expenses?.sql).toContain('ADD COLUMN "detail"');
    // Every statement is breakpoint-terminated but the last, so a file with no markers at all
    // — the hand-written kind — fails here rather than on the production backend.
    expect(statementsOf(expenses?.sql ?? '').length).toBeGreaterThan(10);

    // And 0004, generator output for the same reason: a payments table that existed on PGlite
    // and nowhere else would be a settlement that vanished in production.
    const payments = migrations.find((migration) => migration.tag.includes('payments'));
    expect(payments, 'no committed migration creates the payments table').toBeTruthy();
    expect(payments?.sql).toContain('CREATE TABLE "payments"');
    expect(payments?.sql).toContain('"amount_minor" bigint NOT NULL');
    expect(payments?.sql).toContain('"deleted_at" timestamp with time zone');
    expect(payments?.sql).toContain('"recorded_by" uuid');
  });
});

describe('the client seam', () => {
  // A connection string the driver rejects before it opens a socket: these cases are about
  // WHICH driver the session was built from, and none of them should reach a network.
  const unreachable = 'not-a-connection-string';

  it('createDatabase takes the driver as an argument, so no test has to mock this file', async () => {
    const db = await useTestDatabase();
    expect(typeof db.select).toBe('function');
    expect(typeof createDatabase).toBe('function');
    expect(typeof setDatabase).toBe('function');
  });

  it('builds the session the tag names, for each driver', async () => {
    // The regression for mistaking a Neon Pool for PGlite. Both have a `query` method — the
    // Pool inherits one — so a structural guess identified every Neon session as PGlite, and
    // every query and transaction on the DATABASE_URL path then threw at the first round trip.
    const pglite = await useTestDatabase();
    const neon = createDatabase({ kind: 'neon', pool: new Pool({ connectionString: unreachable }) });

    expect(isPgliteSession(pglite)).toBe(true);
    expect(isPgliteSession(neon)).toBe(false);
  });

  it('a Neon session fails on the CONNECTION, not on the shape of the driver', async () => {
    const db = createDatabase({ kind: 'neon', pool: new Pool({ connectionString: unreachable }) });
    const failure = await db.execute(sql`SELECT 1`).then(
      () => null,
      (error: Error) => error.message,
    );

    expect(failure).not.toBeNull();
    // The PGlite session calls query() with PGlite's three-argument shape, which this driver
    // rejects as "n is not a function" before it ever looks at the connection string.
    expect(failure).not.toMatch(/is not a function/);
  });

  it('takes ONE connection for the migrator rather than borrowing one per statement', async () => {
    // A Postgres advisory lock is session-scoped, and Pool.query() takes a client from the
    // pool and returns it the moment that one statement finishes — so a lock taken that way
    // spans nothing, and the connection it leaked back into the pool still holds it.
    const pool = new Pool({ connectionString: unreachable });
    const connect = vi.spyOn(pool, 'connect');
    const db = createDatabase({ kind: 'neon', pool });

    await expect(withPinnedSession(db, () => Promise.resolve('unreachable'))).rejects.toThrow();
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('a PGlite instance is already one connection, so pinning it is the identity', async () => {
    const db = await useTestDatabase();
    let pinned: unknown;
    await withPinnedSession(db, (session) => {
      pinned = session;
      return Promise.resolve();
    });
    expect(pinned).toBe(db);
  });
});