# Roadmap

Rebuilt 2026-10-02 from `maintainer/issues.json` (11 open), `maintainer/pulls.json` (1 open),
`maintainer/closed.json` (0 closed). No `maintainer/roadmap.md` existed — this is the first one.

## Shipped

**Nothing a person can use yet.** The repository has no application code: no `src/`, no `tests/`,
and all four verbs in `package.json` (`sdlc:verify`, `sdlc:serve`, `sdlc:seed`, `sdlc:ready`) are
`echo` stubs. What exists is the written product — `docs/prd.md`, `docs/trd.md` (TR-1..TR-27),
`docs/ui.md`, `docs/spec/tabs.md`, eleven ADRs, `.sdlc/memory/project.md` — and the pipeline
itself. That is the correct state for a project one day old; say it plainly rather than
implying a partial product.

## In flight

- **#3 Stand up the app: database, migrations, health check and real accounts** — open PR #13 from
  `sdlc/issue-3`, labelled `sdlc:qa`. This is the **head of the whole chain**: all ten other
  children of #1 are parked behind it, and it is the piece that makes `sdlc:verify`, `sdlc:serve`
  and `sdlc:ready` real for the first time. Nothing else in the product can start until it merges.
  `ci-verify` fails any branch carrying code while `sdlc:verify` is still a stub, so this PR is
  also where that gate is met or missed.

## Next

1. **Land #3, then let #4 run.** The chain is strictly serial from #3 through #9, and #4 is the
   first piece that defines group and membership data plus `src/lib/access.ts`, which every later
   read copies. There is nothing worth deciding until the schema and the three real verbs exist.
2. **Watch the one genuine fork after #6: #7 and #8 are independent of each other.** #7 (edit and
   delete an expense) and #8 (balances and simplified debts) both depend on #6 and nothing else.
   Everything else is a line. If the pipeline serialises these two for any reason, that is the
   cheapest hour in the whole plan to recover — and worth watching, because they touch the same
   money core from opposite ends.
3. **#12's README half does not actually need #9.** #12 is parked on #9, but half of it —
   documenting the environment variables the code reads — depends only on #3, which is where those
   variables come into existence. If the deploy path matters sooner than the performance numbers,
   the right move is a **re-split of #12**, not a new issue. The performance half (TR-25, p75
   under one second against the production build) genuinely does need every screen, so it should
   stay behind #9.

## Blocked, and on whom

None of these is agent work. All four are a person, and none can be filed as an issue because
`.sdlc/config.yml` is a reserved path no ticket branch may edit.

- **QA cannot test most of the product** — `qa_auth.mode` is `none` in `.sdlc/config.yml`, so QA
  arrives signed out and can only drive sign-up and the signed-out screens. `fixture` is the right
  setting and the config's own comment says it needs exactly what already holds (compose mode,
  local-only allowlist) — but it only becomes *possible* when **#11** lands the seed's known-password
  users. So between #4 and #11, roughly eight PRs get QA that cannot reach the money screens.
  This is the single highest-value thing on this list, because it is invisible in the issue list:
  those PRs look green. **On: the repository owner, after #11 merges.**
- **No Vercel project and no Neon database exist.** Nothing deploys, and #12's deploy guide and its
  Neon claims are proved by a human opening a preview, not by QA. #12 already states this plainly.
  **On: the repository owner.**
- **`env.mode: compose` versus `preview`** — compose proves the production build against local
  PGlite and says nothing about the Neon path; preview proves Neon and needs a preview-scoped
  `DATABASE_URL` that is never production. This changes what QA is able to conclude, not the
  application. **On: the repository owner.**
- **Which currencies must be supported at launch** — #4 assumes any ISO 4217 code formatted through
  `Intl`. A fixed short list would close the picker and let the README say so. Not blocking #4,
  because the assumption is written down; decide before #12. **On: the repository owner.**

## Epics

- **#1 Build Tabs from the spec (`docs/spec/tabs.md`)** — in flight, **0 of 10 children closed**.
  Head is #3, with PR #13 open against it.

Dependency graph between the open children, so the next run does not re-derive it:

```
#3 ──▶ #4 ──▶ #5 ──▶ #6 ──┬──▶ #7  (edit/delete an expense)
                          └──▶ #8 ──▶ #9 ──┬──▶ #10 (search, filters, activity)
                                           ├──▶ #11 (seed)      [unblocks QA auth]
                                           └──▶ #12 (README, deploy, perf)
```

There is **one open epic**, so there are no `epic_links` — nothing to depend on anything else.

### Spec coverage

**Every TR and every S- section is claimed.** TR-1..TR-27 are each covered by at least one child
(#3 carries TR-10/11/12/20/21/22/24; #4 TR-1/12/13/17; #5 TR-14/15; #6 TR-2/3/5/17/23; #7 TR-4/17;
#8 TR-6/8/9/13/16; #9 TR-7/17; #10 TR-18/19; #11 TR-26; #12 TR-22/25/27), and S-2..S-10 are each
covered, with S-1 and S-11 carried by the epic itself. **No uncovered spec remains**, so there is
nothing for a Spec coverage issue to say, and none is filed. When the last child of #1 closes,
#1 closes with nothing dropped.

## Notes for the next run

- **Zero `untrusted` issues** in this survey's input. All 11 open issues are the pipeline's own.
- **Issue #2 is not open and not in the last-30 closed list.** It was the project/architecture
  ticket, merged as PR #2. Nothing is waiting on it.
- **The issue bodies are numbered two behind their issue numbers.** Every body refers to "piece N"
  where piece N is issue **N+2** — piece 5 is #7, piece 6 is #8, piece 7 is #9, piece 8 is #10. The
  `Depends on #N` lines are correct and use real numbers; only the prose is off by two. It is
  harmless when read carefully and misleading when skimmed, and it is not fixable by filing: the
  pipeline cannot rewrite a parked issue's body from a survey. Read `Depends on:` first and ignore
  "piece N" in the prose.
- **The decision recorded on #1 has landed in the docs**, and is worth confirming rather than
  assuming on any future run: TR-4 in `docs/trd.md` now carries the edit-and-delete rule, the
  expense form in `docs/ui.md` describes the edit reopening from the stored rule, and ADR-0011
  records the split rule stored beside its shares. A search for the pre-decision wording ("an edit
  never changes a balance") finds it nowhere but in #7's own body, where it is quoted as the stale
  text to be ignored. Any future copy of that sentence outside #7 is drift and should be reported.
- **`.sdlc/memory/project.md` is already stale in a way that resolves itself.** It says "Nothing
  here runs yet: the repository has no code" and lists all four verbs as stubs; #3 makes three of
  them real. That is the Librarian's file and it is updated nightly from what merged — do not file
  an issue about it. `.sdlc/memory/qa/environment.md` and `qa/selectors.md` are still stubs for the
  same reason.

## What this survey considered and did not file

Recorded so the next run does not re-derive them and file them as if they were new.

- **A cross-piece test for "the ledger never drifts"** (record → edit → pay → delete → balances
  return to zero, driven as one flow). Tempting, and it is the kind of gap that becomes real
  around #9. But each seam is already owned: #6 property-tests the split sum over 10,000 random
  totals, #7 AC-8 asserts a rounding-rule change leaves stored balances byte-identical, #8 AC-4
  asserts a balance is a sum of stored rows, #9 AC-4 asserts a deleted payment restores exactly
  what it moved. A test spanning all four would mostly re-run those against the current code. If a
  piece is ever cut for time and drops its own invariant test, that is when this becomes worth
  filing — named at that point, not now.
- **A warning about the write-path-only split function being called on a read path** — this is the
  sharpest hazard in the money core, since #6 writes the rule-to-share function, #7 re-runs it on
  edit, and #8 reads balances and must not. But #8's body and AC-4 already name it in exactly those
  words, and ADR-0011 exists. Restating it as an issue would be noise on top of a warning already
  at the point of danger.
- **An issue to fix the piece-numbering drift above** — unfillable in principle. The pipeline cannot
  rewrite a parked issue's body, and a ticket whose deliverable is a change to `.sdlc/memory/` may
  not be filed at all. It lives here instead, which is where the next run reads it.