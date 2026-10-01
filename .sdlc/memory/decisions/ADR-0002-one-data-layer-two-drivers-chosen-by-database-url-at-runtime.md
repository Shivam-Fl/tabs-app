# ADR-0002: One data layer, two drivers, chosen by DATABASE_URL at runtime

**Date:** 2026-10-01
**Status:** accepted
**Forced by:** #1

## Decision
src/db/client.ts inspects DATABASE_URL once at import and returns either drizzle-orm/neon-serverless over a @neondatabase/serverless Pool or drizzle-orm/pglite over one in-process PGlite instance. Both are typed as the same Drizzle instance, so no call site branches on the backend. PGlite is held in a process singleton and is in-memory unless PGLITE_DATA_DIR names a directory.

## Why
The spec requires zero-setup local development, CI and QA against real Postgres semantics, and no data loss in production. Two backends with one interface is the only arrangement that gives all three, and the PGlite single-connection limit means the instance must be a singleton or the same directory can be opened twice and corrupted.

## Consequences
Easy: development, tests and QA need nothing installed and no account, and the SQL that runs in CI is the SQL that runs in production. Hard: PGlite is a single connection, so a slow query blocks every other request locally in a way Neon will not reproduce; nothing may depend on connection-scoped state, LISTEN/NOTIFY or multiple connections; and the two backends can diverge on the rare extension or collation PGlite does not carry.
