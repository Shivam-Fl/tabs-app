import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { drizzle as drizzleNeon } from 'drizzle-orm/neon-serverless';
import type { NeonDatabase } from 'drizzle-orm/neon-serverless';
import type { PGlite } from '@electric-sql/pglite';
import type { Pool } from '@neondatabase/serverless';

import * as schema from './schema';
import { users } from './schema';

/**
 * The driver, TAGGED where it is built.
 *
 * The tag is not decoration. Both drivers expose a `query` method — the Neon Pool inherits one
 * from its prototype — so any structural guess at "which driver is this" identifies a Pool as
 * PGlite and builds a PGlite session over a Neon connection, which throws at the first query
 * and the first transaction. The tag is the one thing the two do not share, and it is set by
 * the code that knows which it just constructed.
 *
 * The driver is taken as a PARAMETER rather than read from the environment inside, which is
 * what lets the integration tests run the real route handlers and the real actions against a
 * throwaway PGlite with no mock of this file.
 */
export interface PgliteDriver {
  kind: 'pglite';
  instance: PGlite;
}

export interface NeonDriver {
  kind: 'neon';
  pool: Pool;
}

export type Driver = PgliteDriver | NeonDriver;

export function createDatabase(driver: PgliteDriver): PgliteDatabase<typeof schema>;
export function createDatabase(driver: NeonDriver): NeonDatabase<typeof schema>;
export function createDatabase(driver: Driver): Database {
  if (driver.kind === 'pglite') {
    const client = drizzlePglite(driver.instance, { schema });
    // One PGlite instance is one connection, so it is already the pinned session.
    pins.set(client, {
      kind: 'pglite',
      pin: () => Promise.resolve({ session: client, release: () => Promise.resolve() }),
    });
    return client;
  }

  const client = drizzleNeon(driver.pool, { schema });
  pins.set(client, {
    kind: 'neon',
    pin: () =>
      // A dedicated connection, because Pool.query() takes one from the pool and gives it back
      // after a single statement — which is no use to a session-scoped advisory lock.
      driver.pool.connect().then((connection) => ({
        session: drizzleNeon(connection, { schema }),
        release: () => {
          connection.release();
          return Promise.resolve();
        },
      })),
  });
  return client;
}

export type Database = PgliteDatabase<typeof schema> | NeonDatabase<typeof schema>;

/**
 * Whether this session is the PGlite one. Unlike a structural guess — a Neon Pool has a
 * `query` method on its prototype, so a guess names it PGlite — this reads the tag
 * createDatabase recorded when it built the session, which cannot disagree with it.
 */
export function isPgliteSession(db: Database): db is PgliteDatabase<typeof schema> {
  const pin = pins.get(db);
  if (!pin) throw new Error('tabs: this database session was not built by createDatabase');
  return pin.kind === 'pglite';
}

export type NewUser = typeof users.$inferInsert;

/**
 * Inserts a user, returning its id, or null when the unique constraint on email said no.
 *
 * It lives here because `.returning(fields)` is an OVERLOADED method, and TypeScript resolves
 * the overloads of a union of the two drivers' builders to the zero-argument one — so every
 * insert that reads a column back fails to typecheck against the union. Narrowing by the tag
 * this module recorded is the only check that tells the two apart, and doing it once here
 * keeps it out of the action that needs it.
 */
export async function insertUser(db: Database, values: NewUser): Promise<string | null> {
  const inserted = isPgliteSession(db)
    ? await db.insert(users).values(values).onConflictDoNothing({ target: users.email }).returning({ id: users.id })
    : await db.insert(users).values(values).onConflictDoNothing({ target: users.email }).returning({ id: users.id });
  return inserted[0]?.id ?? null;
}

interface Pin {
  kind: Driver['kind'];
  pin: () => Promise<{ session: Database; release: () => Promise<void> }>;
}

/**
 * The slot the resolved instance lives on. A module-level variable would be enough in
 * production, but dev reloads modules without restarting the process, and two PGlite
 * instances opening the same data directory is a real corruption. Putting it on globalThis
 * means the second reload finds the first one. It is also the seam tests/helpers/pglite.ts
 * installs its own instance on, before any route or action module is imported.
 */
interface TabsGlobal {
  __tabsDatabase?: Database;
  __tabsDatabasePromise?: Promise<Database>;
  /**
   * How to pin one connection behind each session, recorded at the point the driver was built
   * — the only place it exists. On globalThis for the reason above: Next compiles Server
   * Actions into their own server bundle, so there are two copies of this module, and a
   * module-level map in one would be invisible to the session the other one built.
   */
  __tabsPins?: WeakMap<object, Pin>;
}

const globals = globalThis as typeof globalThis & TabsGlobal;

const pins = (globals.__tabsPins ??= new WeakMap<object, Pin>());

/**
 * Runs `body` against a session that holds ONE connection for its whole duration.
 *
 * Postgres advisory locks are session-scoped, so a lock taken through a pooled statement
 * belongs to whichever client the pool happened to hand out and is gone by the next one. That
 * makes "the lock spans the critical section" a property of the pool's idle-reuse behaviour
 * rather than of the code, and it inverts into a hang — a session returned to the pool still
 * holding the lock — the moment a second connection is in play. The migrator is the only
 * caller; it is here because the pinned connection is a property of the driver, and the
 * driver is what this file owns.
 */
export async function withPinnedSession<T>(db: Database, body: (session: Database) => Promise<T>): Promise<T> {
  const pin = pins.get(db);
  if (!pin) throw new Error('tabs: this database session was not built by createDatabase');

  const { session, release } = await pin.pin();
  try {
    return await body(session);
  } finally {
    await release();
  }
}

/** The one instance, built at most once per process. */
async function initialise(): Promise<Database> {
  // Lazily, so a strict-mode failure surfaces as a boot error rather than an import-time throw.
  const { config } = await import('@/lib/env');
  const databaseUrl = config().databaseUrl;

  const database = databaseUrl
    ? createDatabase({ kind: 'neon', pool: await neonPool(databaseUrl) })
    : createDatabase({ kind: 'pglite', instance: await pglite() });

  globals.__tabsDatabase = database;
  globals.__tabsDatabasePromise = undefined;
  console.log(`tabs: database driver ${databaseUrl ? 'neon' : 'pglite'}`);
  return database;
}

async function neonPool(databaseUrl: string): Promise<Pool> {
  const { Pool: NeonPool, neonConfig } = await import('@neondatabase/serverless');
  // The WebSocket driver, because the migrator needs a connection it can hold for the length
  // of the migration (see withPinnedSession). It is configured globally, not per pool, because
  // that is where the driver reads it.
  neonConfig.webSocketConstructor = WebSocket;
  return new NeonPool({ connectionString: databaseUrl });
}

async function pglite(): Promise<PGlite> {
  const { PGlite: PGliteCtor } = await import('@electric-sql/pglite');
  // In-process and in-memory: nothing to install for development, CI or QA.
  return new PGliteCtor();
}

/**
 * The instance, awaited. Everything in the application awaits this rather than reading a
 * module-level binding, because building the driver is asynchronous.
 */
export async function database(): Promise<Database> {
  if (globals.__tabsDatabase) return globals.__tabsDatabase;
  globals.__tabsDatabasePromise ??= initialise();
  return globals.__tabsDatabasePromise;
}

/** For tests: install an instance before any route or action module is imported. */
export function setDatabase(instance: Database): void {
  globals.__tabsDatabase = instance;
  globals.__tabsDatabasePromise = undefined;
}