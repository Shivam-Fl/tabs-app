/**
 * Migrations run on boot, in development, CI, QA and production, from this one place.
 *
 * Next calls register() once per server start on the Node runtime. It is used rather than
 * middleware because middleware runs on the Edge runtime, and the PGlite WASM must not be
 * bundled — that is the failure conventions.md names. It returns early under
 * NEXT_PHASE=phase-production-build, which is why validation can be a boot-time call and
 * `next build` never reaches it.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  // A missing required variable in strict mode stops startup here, with the one message that
  // names every variable it is missing.
  const { config } = await import('@/lib/env');
  config();

  const { database } = await import('@/db/client');
  const { loadMigrations, migrate } = await import('@/db/migrate');

  const db = await database();
  const applied = await migrate(db, loadMigrations());
  console.log(`tabs: TABS_ENV=${config().tabsEnv || '(unset — strict)'}, applied ${applied} migration(s) on boot`);
}