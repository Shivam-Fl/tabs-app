#!/usr/bin/env node
/**
 * sdlc:seed.
 *
 * It REFUSES unless TABS_ENV is unset or exactly 'local'. Mirroring src/lib/env.ts's polarity
 * rather than inverting it is deliberate:
 *
 *   - a NODE_ENV-keyed guard would refuse under `next start`, which sets NODE_ENV=production
 *     itself and is the only way this script is ever run;
 *   - a `TABS_ENV === 'production'` guard would fail OPEN on a deployment whose TABS_ENV is
 *     misspelled as 'prod', which is the exact failure TR-26 forbids.
 *
 * Unset means local, and a real deployment that forgot TABS_ENV would already be refusing to
 * boot.
 *
 * It opens no database handle and imports nothing from src/. The local database is in-process
 * and in-memory inside the app's own process (ADR-0002, ADR-0007), so a second process cannot
 * reach it — a bare `node` cannot import the TypeScript client either. What this can do is
 * confirm the application is up and answering, which is the precondition the real seed needs.
 *
 * Piece 9 replaces this body with the POST /api/dev/seed call ADR-0007 specifies.
 */
const tabsEnv = process.env.TABS_ENV;

if (tabsEnv !== undefined && tabsEnv !== 'local') {
  console.error(
    `sdlc:seed: refusing to run — TABS_ENV is ${JSON.stringify(tabsEnv)}, and seeding is available ` +
      'only where the application itself boots on local defaults.',
  );
  process.exit(1);
}

const url = 'http://localhost:3000/api/health';

let response;
try {
  response = await fetch(url);
} catch (error) {
  console.error(`sdlc:seed: the application is not answering on ${url} — ${error.message}`);
  console.error('sdlc:seed: start it first (npm run sdlc:serve), then run this again.');
  process.exit(1);
}

console.log(`sdlc:seed: ${url} answered ${response.status}`);
if (response.status !== 200) {
  console.error(`sdlc:seed: refusing to seed — the application is not healthy (${response.status}).`);
  process.exit(1);
}

console.log('sdlc:seed: the application is up. This slice writes no rows; piece 9 seeds through the app.');
