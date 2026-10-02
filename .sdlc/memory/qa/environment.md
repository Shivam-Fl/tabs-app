# QA environment notes

Env quirks, login recipes and flaky spots. Read before browser QA.

## Until the first ticket lands, there is nothing to drive

**Symptom.** `env.boot` is `npm run sdlc:serve`, that command prints a line and exits 0, and
then every navigation fails with a connection error against `http://localhost:3000`. Nothing
listens. The readiness poll against `env.ready: "/"` never succeeds and the run times out
looking like a build problem.

**Cause.** All four `sdlc:*` verbs in `package.json` are stubs — `sdlc:serve`, `sdlc:ready`,
`sdlc:seed` and `sdlc:verify` are `echo` lines, because the repository has no `src/` yet. A stub
exits successfully, so the boot step passes and the failure surfaces later as an unreachable
port rather than as a missing app.

**Also note.** `env.ready` is `"/"`, but the target recorded for `sdlc:ready` in
`.sdlc/memory/project.md` is `curl -fsS --max-time 5 http://localhost:3000/api/health`. Once
`/api/health` exists, the readiness check should be that endpoint, not `/`, so a boot that
serves HTML but not the database is still caught. `env.ready` lives in `.sdlc/config.yml`,
which is a reserved path, so this is the maintainer's to change — flag it, do not edit it.

**How to check quickly.** `npm run sdlc:serve; echo $?` — a line of text and exit 0 means the
verb is still a stub, whatever the branch says.

**Invalidated by** the first ticket that lands an `app/` directory and makes `sdlc:serve` real
(the spec's order-of-work step 1). Delete this section then; the seed ordering note below
outlives it.

## Seed order, once there is something to seed

`sdlc:seed` runs a script that calls `POST /api/dev/seed` **over HTTP**, so the app must be up
and answering before seeding is attempted — hence seed after ready, never in parallel with boot.

**Why it is not a direct database script.** When `DATABASE_URL` is unset the database is an
in-process PGlite holding a single exclusive connection to its data directory. A second process
opening that directory — which is exactly what a direct-connection seed script would be — risks
corrupting it. Going through the app's own endpoint is the one path that behaves identically on
PGlite and on Neon. Full reasoning in [ADR-0007](../decisions/ADR-0007-fixtures-reach-the-database-through-the-app-not-around-it.md).

**Consequence for QA.** The seed is a reset, not an append: seeding twice gives the same state,
so QA can re-seed between cases without leaking state, and a case that mutates fixtures can be
recovered from by re-seeding rather than by rebuilding the environment.

## Signing in

`.sdlc/config.yml` has `qa_auth.mode: none`, so QA is handed no credentials and can only drive
the signed-out and sign-up paths. It should be `fixture` against the seed's known-password
users, and the file is reserved, so it is the maintainer's change. Raised as an open question in
[project.md](../project.md). Until it changes, treat a QA run as covering the unauthenticated
surface only and say so in the report rather than reporting a pass.
