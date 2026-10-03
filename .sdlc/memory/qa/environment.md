# QA environment notes

Env quirks, login recipes and flaky spots. Read before browser QA.

## The app boots; the PREVIEW may be a build of code you have not written yet

**Symptom.** A browser walk of a brand-new feature passes every step *except* the new one, or
asserts against sentences your diff changed, and everything else is green. Conversely, "I fixed
it but the browser still shows the old behaviour."

**Cause.** `env.boot` (`npm run sdlc:serve`) is `next build && next start` — the server on
`http://localhost:3000` was built when the pipeline booted the work order's base, and it has no
hot reload. Files written after that build are not in `.next`, and there may not even be a
route for them yet: the `/join`, `/expenses` and `/signup` surprises below were all of this
shape. In one 24h window four separate implementers each had to work this out from scratch —
one nearly shipped a pass that would have been a QA of `main`.

**What to do.**
- Establish the build's age first: does `.next` contain the route this work order adds? A
  quick `ls .next/server/app` beats an hour of debugging.
- If you must test new code, either ask the pipeline to rebuild, or `next build` a scratch
  copy and drive it on another port (the convention implementers used is 3100; sibling port,
  keeps the pipeline's server up). Then say in what you hand back WHICH build you drove and
  port you used, so QA does not re-test the wrong commit.
- QA drives localhost:3000 and must confirm its own boot is of the branch under test — the
  evidence should state the code that was verified against, not just "attempt 1".

## Landing on the app for the first time: two config-wrong routes

`.sdlc/config.yml` is reserved, so these are the maintainer's to fix; they are recorded so a
run does not spend its budget discovering them:

- `qa_auth.signup_url: "/signup"` — the app's route is `/sign-up`. A config-driven sign-up
  hits a 404. Every run to date has routed itself to `/sign-up` explicitly; if your plan gets
  the QA machinery to create accounts, check which URL it will use before trusting a
  "sign-up failed" finding.
- `env.ready: "/"` — the recorded target for `sdlc:ready` is
  `curl -fsS --max-time 5 http://localhost:3000/api/health`. `/` passes for a build that
  serves HTML over a broken database; the health endpoint answers 200 in that case only after
  a real query (TR-20). The divergence was flagged before ticket #1 landed code and is still
  open; it is the maintainer's change.

## Sign-up: displayName is required, and the refusal is quiet

A QA script that fills only email and password on `/sign-up` lands back on the form with no
obvious error, because the schema requires `displayName` (80-char cap) and the field is
labelled "Your name", not "Display name". Two of the first implementers' timing-out browser
runs stopped here. Fill all three fields, or expect this.

## Post-action navigation does not survive an unmount — and the fix is a pattern, not a patch

Symptom: a successful action lands the user somewhere wrong (or nowhere), but only on the
page where the write unmounted the control. Seen three ways:

- leave → revalidate turns the members page into not-found and unmounts LeaveButton before an
  effect on action state could push `/?left=<id>` (QA BUG-1 of #22, fixed in #24);
- confirm an invite → revalidate re-renders `/join/[token]` past the form's own branch,
  unmounting the component that owned the `router.push` (fixed by making the whole join
  screen one client component, #22);
- delete expense → the edit route stops resolving once the row is gone, same unmount (fixed in
  #29 by routing navigation through the action's awaited continuation).

The pattern that holds for all three: run the navigation in the awaited continuation of the
Server Action, not in a `useEffect` on action state — a pending promise is not part of the
tree and nothing unmounts it. The comment block on `useMemberAction`
(src/components/member-actions.tsx) is the written form of this; do not "simplify" it back
into an effect. jsdom cannot reproduce the unmount race, so only a real browser walk catches a
relapse — this is the highest-yield thing to walk in a hand-run rebuild.

## Seed order — the endpoint this slice does NOT have yet

`sdlc:seed` (scripts/seed.mjs) currently only checks `GET /api/health` and refuses to run when
`TABS_ENV` is neither unset nor `local`. It writes no rows and imports nothing from `src/`:
the in-process PGlite holds a single exclusive connection to its data directory, so a
second process reaching the database directly would risk corrupting it (ADR-0007). The real
seeding, through `POST /api/dev/seed`, is piece 9 (issue #11) — until then, tests make their
own state and there is nothing for `sdlc:seed` to reset. **Do not** "fix" the stub by writing
a direct-database seed script; that is the exact thing ADR-0007 rules out.

## Signing in

`.sdlc/config.yml` has `qa_auth.mode: none`, so QA is handed no credentials and can only drive
the signed-out and sign-up paths (it does so through `/sign-up`, not `signup_url`). Until the
mode becomes `fixture` or `derived`, treat a run as covering the unauthenticated surface only
and say so in the report rather than reporting a pass.
