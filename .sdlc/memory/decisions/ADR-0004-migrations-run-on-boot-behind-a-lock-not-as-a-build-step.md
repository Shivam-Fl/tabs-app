# ADR-0004: Migrations run on boot behind a lock, not as a build step

**Date:** 2026-10-01
**Status:** accepted
**Forced by:** #1

## Decision
src/db/migrate.ts applies the pending files from drizzle/ whenever the application starts, taking a Postgres advisory lock first and re-reading the applied list inside the lock. It is called from the database client's initialisation path, so development, CI, QA and production all take the same route.

## Why
The spec asks for the same migrations to run automatically in development and on deploy, and a Vercel build step is the wrong place: the build environment and the runtime environment are different, a preview build would migrate a database it does not own, and several cold starts can race. An advisory lock makes the operation idempotent under exactly that race. It also requires the WebSocket Pool driver rather than the HTTP driver, which has no session to hold a lock in.

## Consequences
Easy: there is no separate deploy step to forget, and a preview or a cold start is always on a current schema. Hard: the first request after a deploy pays the migration cost, a failed migration surfaces as a boot error rather than a deploy error, and the advisory lock means the app needs the session-capable driver — the cheaper stateless HTTP driver is not available to us.
