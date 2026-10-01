# Research

_What was learned outside this repository before the architecture was decided, and where_
_it came from. Generated from `project-brief.json` for #1._

## Questions

- Which Postgres driver does Vercel actually support now, and is the obvious package still maintained?
- Can PGlite run inside a Next.js server, and what are its real limits around connections, processes and its data directory?
- What does PGlite install — does it need a postinstall, a native build or anything ci-verify's --ignore-scripts would break?
- Is Drizzle able to speak to both backends from one schema, including running the same migrations against each?
- What are the current stable versions, and what did the most recent Next.js major change in ways this application would trip over?
- What does OWASP currently recommend for password hashing, and is Node's built-in scrypt an acceptable answer?
- Which Neon driver supports the things a migration needs — transactions and a session-scoped advisory lock — and does it work on Vercel?
- Does the version of TypeScript that ships today work with the linter, and does @types/node match the Node version CI runs?

## Findings

### @vercel/postgres is deprecated and Neon is the supported path, so the production driver is @neondatabase/serverless.

**What the source says.** The package's own registry metadata carries a deprecation notice: "@vercel/postgres is deprecated. If you are setting up a new database, you can choose an alternate storage solution from the Vercel Marketplace. If you had an existing Vercel Postgres database, it should have been migrated to Neon as a native Vercel integration." Vercel's documentation states "Vercel Postgres is no longer available. If you had an existing Vercel Postgres database, we automatically moved it to Neon in December 2024."

**Source.** https://www.npmjs.com/package/@vercel/postgres and https://vercel.com/docs/postgres

**Confidence.** 95

**Changed.** stack.choice, and the decision to add Neon rather than any Vercel-owned database.

### PGlite is a single exclusive connection, and opening the same data directory from a second process risks corruption — so it must be a process singleton and nothing may connect to it out of band.

**What the source says.** The PGlite documentation states "As PGlite only has a single exclusive connection to the database, we provide a multi-tab worker to enable sharing a PGlite instance between multiple browser tabs." Supabase's write-up of building on PGlite repeats it: "PGlite has a single-connection limit which may not work with all clients." The PGlite repository's own issue #323 carries the maintainer guidance: "There is no support for concurrent connections and you are likely to corrupt the database if you open it multiple times at once."

**Source.** https://pglite.dev/docs/ and https://github.com/electric-sql/pglite/issues/323

**Confidence.** 90

**Changed.** The PGlite singleton in src/db/client.ts, and the decision to seed fixtures through the app over HTTP rather than through a script that opens the database.

### PGlite installs with no dependencies and no install script, so it survives this repository's --ignore-scripts CI install.

**What the source says.** Reading the published package's manifest directly: `@electric-sql/pglite@0.5.8` declares `dependencies: {}`, `optionalDependencies: {}` and no `postinstall` or `prepare` script — its only scripts are test, build, dev, lint and typecheck. A clean `npm install --ignore-scripts` of it alongside drizzle-orm and @neondatabase/serverless completed with exit status 0.

**Source.** first-party: npm registry manifest for @electric-sql/pglite@0.5.8, installed and inspected locally

**Confidence.** 95

**Changed.** stack.choice, and the PGlite half of the two-backend decision.

### Drizzle ships first-class drivers and migrators for both backends, so one schema and one migration list serve PGlite and Neon.

**What the source says.** The installed drizzle-orm@0.45.3 contains `pglite/` (driver, session and migrator) and `neon-serverless/`, `neon-http/` (both with driver, session and migrator). Verified by listing the package's own directories after a real install rather than from documentation.

**Source.** first-party: node_modules/drizzle-orm@0.45.3, installed locally and listed

**Confidence.** 95

**Changed.** The two-backend architecture, and the decision that migrations are generated SQL applied to either.

### The Neon HTTP driver cannot run migrations, because it has no session to hold an advisory lock in; the Pool driver can.

**What the source says.** The @neondatabase/serverless documentation describes the HTTP function as for one-shot queries sent over fetch, with "only one query at a time this way", and states plainly that "sessions and transactions are not supported" — it offers only a non-interactive `sql.transaction([...])`. The Pool/Client WebSocket driver is the one that provides "session or interactive transaction support" and node-postgres compatibility. An advisory lock is session-scoped, so it is available only through the latter.

**Source.** https://github.com/neondatabase/serverless

**Confidence.** 85

**Changed.** The choice of drizzle-orm/neon-serverless over neon-http, and the on-boot migration strategy.

### Next.js 16 makes Turbopack the default for dev and build, removes `next lint`, and no longer lints during `next build` — so a repository with empty typecheck and lint entries in verify is left with no linting at all unless its own verify command runs it.

**What the source says.** The version 16 upgrade guide: "Starting with Next.js 16, Turbopack is stable and used by default with `next dev` and `next build`"; and under Removals, for the `next lint` command: "The `next lint` command has been removed. Use Biome or ESLint directly. `next build` no longer runs linting." .sdlc/config.yml has verify.typecheck, verify.lint, verify.build and verify.e2e all empty, with only verify.unit set to `npm run sdlc:verify`.

**Source.** https://nextjs.org/docs/app/guides/upgrading/version-16 and first-party: .sdlc/config.yml

**Confidence.** 95

**Changed.** The composition of sdlc:verify, and the conventions entry making tsc and eslint explicit steps.

### Next.js 16 requires async access to cookies(), headers() and params, and has renamed middleware.ts to proxy.ts with a Node.js-only runtime.

**What the source says.** The upgrade guide: "Starting with Next.js 16, synchronous access is fully removed. These APIs can only be accessed asynchronously", listing cookies, headers, draftMode, params and searchParams; and "The `middleware` filename is deprecated, and has been renamed to `proxy`... The `edge` runtime is NOT supported in `proxy`. The `proxy` runtime is `nodejs`, and it cannot be configured." It also states minimums of Node 20.9 and TypeScript 5.1.

**Source.** https://nextjs.org/docs/app/guides/upgrading/version-16

**Confidence.** 95

**Changed.** conventions — where a request-scoped authorisation check belongs — and the invariants about server-side authorisation.

### @electric-sql/pglite is not on Next.js's automatic server-external list, so it has to be named in serverExternalPackages or the WASM Postgres will be bundled and fail.

**What the source says.** The serverExternalPackages reference lists the packages Next opts out of server bundling by default; the list includes argon2, bcrypt, better-sqlite3, pg, @prisma/client and @node-rs/argon2, and does not include @electric-sql/pglite. The page describes the option as opting a dependency out of bundling "and use native Node.js require".

**Source.** https://nextjs.org/docs/app/api-reference/config/next-config-js/serverExternalPackages

**Confidence.** 90

**Changed.** conventions, and the first ticket's next.config.ts.

### OWASP accepts scrypt as an approved password KDF immediately behind Argon2id, at N = 2^17, r = 8, p = 1.

**What the source says.** The Password Storage Cheat Sheet orders the options Argon2id (preferred), scrypt ("use when Argon2id is unavailable"), bcrypt (legacy systems only, passwords limited to 72 bytes) and PBKDF2-HMAC-SHA-256 (FIPS-140 only), and states for scrypt: "use a CPU/memory cost parameter (N) of 2^17, a block size (r) of 8 (1,024 bytes), and a parallelization parameter (p) of 1". The page does not name Node's crypto implementation specifically, so the mapping from that guidance to crypto.scrypt is this brief's judgement, not the page's.

**Source.** https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html

**Confidence.** 80

**Changed.** The password hashing decision, and therefore the decision to take no native dependency at all.

### TypeScript 7.0.2 is the current latest, but typescript-eslint's peer range excludes it, so the project must pin TypeScript 5.9 to keep type-aware linting installable.

**What the source says.** `npm view typescript dist-tags` returns `latest: 7.0.2`. `npm view typescript-eslint@8.71.0 peerDependencies` returns `{ eslint: "^8.57.0 || ^9.0.0 || ^10.0.0", typescript: ">=4.8.4 <6.1.0" }`, which 7.0.2 does not satisfy. The published 5.x line ends at 5.9.3, inside the range.

**Source.** first-party: npm registry, queried directly for typescript and typescript-eslint

**Confidence.** 95

**Changed.** stack.choice and the version-pin decision.

### Prisma cannot be used without an edit to a path no agent may change, because its engines are fetched by a postinstall hook and ci-verify installs with scripts disabled.

**What the source says.** `@prisma/engines` declares `"postinstall": "node scripts/postinstall.js"` in its published manifest. The repository's own CI workflow states: "Install scripts are not run. This job's verdict is the PR's checks, and a dependency's postinstall runs before every one of them", and its error message directs a project that needs one to "run it by name in verify.prepare in .sdlc/config.yml" — a file listed under forbidden_paths in that same config.

**Source.** first-party: npm registry manifest for @prisma/engines, and .github/workflows/ci-verify.yml

**Confidence.** 90

**Changed.** The ORM decision, and the rejected stack entry for Prisma.

### @types/node's current latest line targets Node 26 while ci-verify runs Node 22, so the types must be pinned to the 22.x line to match the runtime.

**What the source says.** `npm view @types/node version` returns 26.6.3; the 22.x line exists and currently ends at 22.20.4. `.github/workflows/ci-verify.yml` pins `node-version: 22` in both of its jobs.

**Source.** first-party: npm registry, and .github/workflows/ci-verify.yml

**Confidence.** 90

**Changed.** conventions and the exact version pins in stack.choice.

## Sources not trusted

- Blog and newsletter comparisons of PGlite against other embedded databases (kanopylabs, pkgpulse, the PGlite Hacker News thread). They compare feature matrices and benchmarks, none of which bears on the two questions here — whether it installs without a script, and whether a second process can open its data directory — and the two first-party sources that answer those are cited instead.
- Vercel's 'Vercel with Neon Postgres' template and the broad 'what replaced Vercel Postgres' blog posts. The template is a starting point whose dependency choices would have been made for its own reasons, and the blogs restate the deprecation the package's own manifest already states authoritatively.
- Search-engine summaries of current versions. Every version in this brief was read from the npm registry directly, because the summaries disagreed about release dates and one reported a 2024 build step as current.

## Assumptions this rests on

### A Next.js 16.3 application builds and boots with PGlite 0.5.8 behind `serverExternalPackages`, under Turbopack, on Node 22.

**Believed because.** PGlite is documented as running on Node with no install step, and serverExternalPackages is the documented way to keep a WASM-backed package out of the server bundle. None of it has been run in this repository, which has no code.

**If wrong.** The first ticket fails at `next build` or at first query, and the cost is one ticket of diagnosis rather than a redesign — the alternative backends all remain available. This is the single most likely thing to be wrong in this brief.

**Cheapest check.** On the skeleton ticket, run `next build && next start` with DATABASE_URL unset and assert GET /api/health returns 200 before writing anything else. Half a day, and it is the first thing the first ticket does.

### ESLint 10 in flat config works with @next/eslint-plugin-next and typescript-eslint 8.71 together, and the rules can be kept to a small, stable set.

**Believed because.** The Next.js 16 upgrade guide says @next/eslint-plugin-next "now defaults to ESLint Flat Config format, aligning with ESLint v10", and typescript-eslint 8.71 declares a peer range including `^10.0.0`. No repository has run the combination.

**If wrong.** Every pull request is red on lint configuration rather than on product code, and QA spends its runs on the toolchain. It is contained — removing or downgrading the linter touches package.json and one config file — but it recurs on every PR until it is fixed, so it is the second thing the skeleton ticket should settle.

**Cheapest check.** Lint one file on the skeleton ticket, with one type-aware rule enabled, and confirm `sdlc:verify` runs all three stages green.

### A Vercel project can be connected to this repository and a Neon database provisioned, by a human, before the build reaches its deploy step.

**Believed because.** The issue says the product is to be live on Vercel, and the spec names Vercel and Neon. Nothing in the repository provisions either, and the repository is not connected to any Vercel project today.

**If wrong.** Everything up to the deploy step is built and proven by CI and QA, and the product never reaches real users — the whole point of the issue. This is the failure mode that cannot be engineered around, because both steps need credentials only the owner has.

**Cheapest check.** Ask the maintainer to connect the Vercel project and provision Neon now, not at the end; the answer is one word and it changes what the deploy guide can say.

### The Neon Pool driver, held as a module-level singleton on the Vercel Node.js runtime, opens a WebSocket connection per instance and reconnects after a cold start without application-level handling.

**Believed because.** The @neondatabase/serverless documentation shows Pool and Client as the node-postgres-compatible WebSocket drivers, and the Neon-on-Vercel setup uses the Node.js runtime rather than Edge. The documentation's warning about not reusing a Pool across requests is addressed to Edge functions, whose WebSocket cannot outlive one request.

**If wrong.** Database calls fail intermittently in production only — the worst place to discover it, and invisible to CI and to QA in compose mode, since QA runs PGlite. The fix is contained to src/db/client.ts.

**Cheapest check.** Open a preview deployment against a Neon branch and exercise the group screens, before the product has real users. This cannot be settled by any test in this repository.

### `next build` does not need a reachable database, so the build is reproducible with no secrets set.

**Believed because.** Every page reads a session or a dynamic [groupId] param, and Next.js 16 does not prerender those by default without generateStaticParams. If a later ticket makes a page static and database-backed, the in-process PGlite covers the build when DATABASE_URL is unset.

**If wrong.** A build fails in CI for want of a database, or — worse — a Vercel build with a production DATABASE_URL set runs against production during prerender, which can write.

**Cheapest check.** Run `next build` with no environment variables set, on the skeleton ticket, and confirm it succeeds.

### Running the local database entirely in memory is acceptable everywhere except `npm run dev`, because nothing durable is ever expected of it.

**Believed because.** CI and QA seed their own fixtures on every run, and production uses Neon. PGLITE_DATA_DIR turns on file persistence for anyone who wants a local database that survives a restart.

**If wrong.** A developer loses local work between restarts, or QA's seed silently re-seeds a database it was meant to keep — both confusing, neither expensive, and both visible immediately.

**Cheapest check.** None needed; the failure is loud and cheap, and PGLITE_DATA_DIR is the documented escape hatch.

### The ten non-goals in the spec's 'Not in this version' section will not be reopened during the build, and the schema can absorb them without a rewrite if they are.

**Believed because.** The spec states them explicitly and says the design should not make them hard. They are additive: a currency on the expense row, an attachment table, a recurrence column, a rate table, a reset-token table. None of them changes a table's key or a stored amount.

**If wrong.** Password reset and account deletion are the two that touch the auth design most directly, and both are the kind of thing a user asks for early. Both add a column or a table; neither requires changing how a session is stored.

**Cheapest check.** None needed. The brief only needs the non-goals to be written down, which is what the coverage entries are for.
