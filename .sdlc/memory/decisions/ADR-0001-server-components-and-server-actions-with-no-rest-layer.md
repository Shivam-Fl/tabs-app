# ADR-0001: Server Components and Server Actions, with no REST layer

**Date:** 2026-10-01
**Status:** accepted
**Forced by:** #1

## Decision
Pages are React Server Components that call Drizzle directly; mutations are Server Actions in src/app/actions/; exactly two Route Handlers exist, GET /api/health and POST /api/dev/seed. There is no client-side fetch, no client cache and no shared API description.

## Why
Every screen is a read the server can perform and a write a form can post, so an HTTP layer between the two would be a second, driftable description of the same domain. It would also put a client cache in charge of invalidation, which is where a stale-balance bug comes from. Fewer moving parts is the difference between QA finding bugs and QA finding infrastructure.

## Consequences
Easy: a form works without JavaScript; there is no cache to invalidate after a write; the whole data flow is readable in one file per screen. Hard: anything that genuinely needs a public or cross-origin API later has to be added as a Route Handler and a CORS policy, and progressive enhancement outside forms (infinite scroll, optimistic polling) needs a Client Component that calls a Server Action rather than a URL.
