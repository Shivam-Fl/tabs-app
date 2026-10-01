# ADR-0007: Fixtures reach the database through the app, not around it

**Date:** 2026-10-01
**Status:** accepted
**Forced by:** #1

## Decision
POST /api/dev/seed is a Route Handler in the application that rebuilds a fixed set of users, groups, expenses of every split type, a multi-payer expense, payments and an unclaimed placeholder. scripts/seed.mjs — what sdlc:seed runs — is a small Node script that calls that endpoint over localhost. The endpoint refuses to run when NODE_ENV is production.

## Why
Locally the database is PGlite, which is one connection inside one process with a single exclusive handle on its data directory; a second process opening the same directory risks corrupting it. A seed script that connects to the database directly would work against Neon and silently damage the local case, which is the case CI and QA actually run. Going through the app's own HTTP endpoint is the one path that works identically on both backends, and it also exercises the application's own write path and authorisation rather than writing rows behind its back.

## Consequences
Easy: one seed implementation for both backends, QA's fixtures are exactly the shape the application writes, and seeding is available on a Vercel preview. Hard: the seed depends on the app being up, which is why sdlc:seed runs after sdlc:ready; the endpoint is a mutation surface that must be impossible to reach in production, which makes its guard a security requirement rather than a convenience; and the fixtures must be reset rather than appended, so seeding twice gives the same state.
