# ADR-0003: Drizzle, not Prisma — the CI installs with --ignore-scripts

**Date:** 2026-10-01
**Status:** accepted
**Forced by:** #1

## Decision
Drizzle ORM 0.45 with drizzle-kit generating SQL migrations, and the migration files checked in under drizzle/. No code generation step runs at install or at boot.

## Why
ci-verify installs dependencies with --ignore-scripts so that no dependency can run code before the checks that judge the pull request. @prisma/engines fetches its binaries from a postinstall hook, and with that hook skipped the client never generates; the documented fix is a verify.prepare entry in .sdlc/config.yml, which is a reserved path no agent is permitted to edit. Drizzle ships TypeScript source, needs no install step, and has first-party drivers for both backends, so the same schema and the same migrations run on each.

## Consequences
Easy: `npm ci --ignore-scripts` produces a working checkout; the schema is readable TypeScript rather than a generated client; no binary is ever downloaded during a build. Hard: no Prisma Studio equivalent worth having, relations and type inference are more manual, and a schema change needs an explicit `drizzle-kit generate` and a reviewed SQL file rather than an implicit regeneration.
