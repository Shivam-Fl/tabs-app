# Conventions

Written from the project brief for #1, so every ticket starts from the same
rules. Reviews add to it as they find patterns; correct it here rather than arguing in a ticket.

## Stack
TypeScript 5.9 in strict mode on Node 22; one Next.js 16.3 App Router application (React 19.3, Turbopack) deployed to Vercel; Drizzle ORM 0.45 over PostgreSQL 16 — Neon via @neondatabase/serverless 1.2 (Pool/WebSocket driver, drizzle-orm/neon-serverless) when DATABASE_URL is set, in-process @electric-sql/pglite 0.5.8 (drizzle-orm/pglite) when it is not; Zod 4.6 for every input that crosses a boundary; Tailwind CSS 4.3 (@theme tokens) for all styling; Vitest 5 with @testing-library/react for unit and integration tests. No other ORM, no client state library, no auth framework, no native addons, no e2e runner.

## Rules
- src/ is the only place product code lives; nothing imports from .sdlc/ and nothing in .sdlc/ imports from src/.
- Files are kebab-case (db/client.ts, lib/money.ts, components/ui/empty-state.tsx); directories are single words; React components are PascalCase in .tsx files only.
- Money columns are bigint and are named <something>_minor. Anything that is not money is named for what it is, with no abbreviation.
- All arithmetic on money goes through src/lib/money.ts. A reviewer should reject a '+', '-' or '/' applied to an amount anywhere else, and a lint rule enforces that a money value is never typed as number.
- Server Components do the reading; 'use client' appears only where there is genuine interaction — forms with client validation, dialogs, and anything reading a browser API. A Client Component never imports from src/db or src/lib/auth.
- Writes are Server Actions in src/app/actions/, one file per noun. Each validates with Zod, calls the authorisation helper before touching data, and wraps its writes in a single transaction.
- Errors from a Server Action are returned as a typed result ({ ok: false, fieldErrors, formError }) that the form renders; they are never thrown for an expected failure and never shown as a raw message to a user.
- Every input crossing a boundary — a form, a route handler, a query parameter — is parsed by a Zod schema in the same file as the action or route that consumes it, and the parsed value, never the raw one, is used.
- Tests live in tests/ beside no source: unit tests as tests/<module>.test.ts, integration tests as tests/integration/<feature>.test.ts running against a fresh in-memory PGlite per test file. A test that needs a network or a real Postgres is a bug in the test.
- sdlc:verify runs, in order: tsc --noEmit, eslint, vitest run. Typecheck first because it is the cheapest and catches the most; lint second because a formatting argument is not worth a model turn; tests last because they are the slowest.
- next.config.ts lists @electric-sql/pglite in serverExternalPackages. It is not on Next's automatic external list, and bundling a WASM Postgres is how the database silently stops working in a build.
- No route sets runtime = 'edge'. The Neon Pool is a process-level singleton and Edge functions cannot hold one; the app runs on the Node.js runtime only.
- A dependency is acceptable when it removes a category of bug we would otherwise write by hand, is pure JavaScript with no install script and no native binary, and is maintained. Anything else needs a decision in this file, not a line in package.json.
- Versions are pinned exactly in package.json, not with carets, so that what CI proves is what QA drives and what Vercel builds.
