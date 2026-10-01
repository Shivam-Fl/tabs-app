# ADR-0010: TypeScript 5.9, not 7.0

**Date:** 2026-10-01
**Status:** accepted
**Forced by:** #1

## Decision
typescript pinned to 5.9.x and @types/node pinned to the 22.x line, matching the Node 22 runtime ci-verify uses.

## Why
TypeScript's current latest is 7.0.2, the native compiler, but typescript-eslint 8.71 declares a peer range of >=4.8.4 <6.1.0. Adopting 7.x therefore makes `npm run lint` uninstallable rather than merely unhappy, and the fix would be to drop type-aware linting — which is the part of linting that catches real bugs in a TypeScript codebase. @types/node's latest line tracks Node 26, while CI runs Node 22, so the latest line would typecheck against APIs the runner does not have.

## Consequences
Easy: the toolchain installs and lints with types on a clean runner, and the type definitions match the runtime that runs them. Hard: the project is a major version behind the compiler and will need a deliberate migration when typescript-eslint widens its range; that migration is a decision for a ticket, with a lint rule, not a version bump nobody reads.
