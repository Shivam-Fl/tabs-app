import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { drizzle as drizzleNeon } from 'drizzle-orm/neon-serverless';
import type { PGlite } from '@electric-sql/pglite';
import type { Pool } from '@neondatabase/serverless';

import * as schema from './schema';

/**
 * One Drizzle instance, whichever Postgres is behind it, so no call site knows which.
 *
 * The driver is taken as a PARAMETER rather than read from the environment inside, which is
 * what lets the integration tests run the real route handlers and the real actions against a
 * throwaway PGlite with no mock of this file.
 */
export function createDatabase(driver: PGlite | Pool): Database {
  const client = isPglite(driver) ? drizzlePglite(driver, { schema }) : drizzleNeon(driver, { schema });
  // Both drivers are the same pg-core query builders over the same wire protocol; they differ
  // only in the session's $client, which nothing above this line touches. Left as a union, the
  // two builder types shadow each other and overloads like .returning(fields) resolve to
  // "expected 0 arguments" at every call site.
  return client as Database;
}

function isPglite(driver: PGlite | Pool): driver is PGlite {
  return typeof (driver as PGlite).query === 'function';
}

export type Database = PgliteDatabase<typeof schema>;

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
}

const globals = globalThis as typeof globalThis & TabsGlobal;

/** The one instance, built at most once per process. */
async function initialise(): Promise<Database> {
  // Lazily, so a strict-mode failure surfaces as a boot error rather than an import-time throw.
  const { config } = await import('@/lib/env');
  const databaseUrl = config().databaseUrl;

  const database = databaseUrl ? createDatabase(await neonPool(databaseUrl)) : createDatabase(await pglite());

  globals.__tabsDatabase = database;
  globals.__tabsDatabasePromise = undefined;
  console.log(`tabs: database driver ${databaseUrl ? 'neon' : 'pglite'}`);
  return database;
}

async function neonPool(databaseUrl: string): Promise<Pool> {
  const { Pool: NeonPool, neonConfig } = await import('@neondatabase/serverless');
  // The WebSocket driver, because the migrator needs a session that can hold the advisory
  // lock for the length of the migration. It is configured globally, not per pool, because
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