# Roadmap

Rebuilt 2026-10-02 from `maintainer/issues.json` (12 open, 0 untrusted), `maintainer/pulls.json` (2 open), `maintainer/closed.json` (3 closed recently). Previous survey's roadmap was `maintainer/roadmap.md`.

## Shipped

What a person can do now that they could not before:

- **Sign up, sign in, and stay signed in.** Email and password accounts with salted scrypt hashes, opaque httpOnly session cookies, sign-out that kills the session server-side, rate-limited sign-in, health endpoint backed by a real database query, and migrations that run on boot on either backend (PGlite locally, Neon with `DATABASE_URL`). The four pipeline verbs (`sdlc:verify`, `sdlc:serve`, `sdlc:seed`, `sdlc:ready`) are real in `package.json` for the first time. (Closed #3, plus its follow-ups #17.)
- **Create a group, see who is in it, and manage membership.** Name, currency, optional type, exactly one owner; owner-only rename, remove, and archive; leave and remove guarded by a zero-balance precondition; a user sees only the groups they belong to. (Closed #4.)

## In flight

- **#5 Invite people to a group, and let them claim a name before they sign up** — open PR #22 from `sdlc/issue-5`, labelled `sdlc:implementing`. This is the head of the remaining chain: #6 is parked on it.
- **#20 Follow-ups from #4: 5 from the review** — open PR #21 from `sdlc/issue-20`, labelled `sdlc:needs-human`. Five non-blocking review findings from PR #19 (negative-sub-unit sign in `formatMinor`, `readMembers` two-step auth, RemoveButton and rename-form missing `router.refresh()`, one unlisted file in the work order). Nothing else in the product waits on it, but its `formatMinor` item bites as soon as #6/#8 render real balances.

Everything else open behind the chain is parked, not stalled: #6 on #5; #7 and #8 on #6; #9 on #8; #10, #11, #12 on #9. #14 (Spec coverage) and #15 (pipeline self-fixes) are bookkeeping, not product work.

## Next

1. **Land #5, then run #6.** #6 (record an expense: who paid, how it splits) defines the expense, payer, share, and split-input tables plus `src/lib/money.ts` — the schema and the remainder rule every later balance sums over. It is the largest work order in the split and the one the product's trustworthiness rests on, so it goes first even though it is the hardest.
2. **Watch the fork after #6: #7 and #8 are independent of each other.** #7 (edit/delete an expense) and #8 (balances, simplified debts, home totals) both depend on #6 and nothing else, touching the same money core from opposite ends (write path vs read path). If the pipeline serialises them, that is the cheapest place in the plan to recover parallelism.
3. **#11's seed unblocks QA auth, not just QA convenience.** Until #11 lands the fixed seed users, `qa_auth.mode: none` means QA can only drive signed-out paths through roughly eight PRs that look green. No reordering is proposed — #11 genuinely needs #9's payments and placeholders first — but the deploy-path half of #12 (env vars exist since #3) could be re-split forward if the human deploy matters sooner than the perf numbers, which need every screen.

## Blocked, and on whom

None of these is agent work. All are a person, and none can be filed as an issue because `.sdlc/config.yml` is a reserved path no ticket branch may edit.

- **QA cannot test most of the product** — `qa_auth.mode` is `none`, so QA arrives signed out. `fixture` is the right setting (compose mode, local-only allowlist already hold), but it only becomes possible when **#11** lands the seed's known-password users. **On: the repository owner, after #11 merges.**
- **No Vercel project and no Neon database exist.** Nothing deploys; #12's deploy guide and its Neon claims are proved by a human opening a preview, not by QA. **On: the repository owner.**
- **`env.mode: compose` versus `preview`** — compose proves the production build against local PGlite and says nothing about the Neon path; preview proves Neon and needs a preview-scoped `DATABASE_URL` that is never production. **On: the repository owner.**
- **Which currencies must be supported at launch** — #4 assumed any ISO 4217 code via `Intl`. A fixed short list would close the picker and let the README say so. Decide before #12. **On: the repository owner.**
- **#15's refused self-fix waits on a secret** — the framework source could not be read without the `SDLC_FRAMEWORK_TOKEN` secret. **On: the repository owner.**
- **#20 waits on a person by label** (`sdlc:needs-human`) while its PR #21 is open. **On: whoever triages the follow-up ticket.**

## Epics

- #1 Build Tabs from the spec (docs/spec/tabs.md) — in flight (2 of 10 children closed: #3, #4).

EPIC DEPENDENCY GRAPH (one line per open epic):

- #1 waits on nothing; it is the only open epic, so there are no `epic_links`.

Dependency graph between its open children, so the next run does not re-derive it:

```
#5 (in flight, PR #22) ──▶ #6 ──┬──▶ #7 (edit/delete an expense)
                                └──▶ #8 ──▶ #9 ──┬──▶ #10 (search, filters, activity)
                                                 ├──▶ #11 (seed)      [unblocks QA auth]
                                                 └──▶ #12 (README, deploy, perf)
#20 (in flight, PR #21) — follow-up to closed #4, blocks nothing
```

### Spec coverage

#14 (Spec coverage) reports 11 sections: 0 built, 8 in flight, 2 not started, 1 non-goal, 0 uncovered. Its per-section table still names closed #3/#4 as "in flight" — bookkeeping lag after this week's merges, not a defect to file. Substance: **every TR-1..TR-27 is claimed** by at least one open or recently closed child, and S-2..S-10 are each carried, with S-1 and S-11 carried by the epic itself. **No uncovered spec remains**, so no Spec coverage issue is filed. When the last child of #1 closes, #1 closes with nothing dropped.

## Notes for the next run

- **Zero `untrusted` issues** in this survey's input. All 12 open issues are the pipeline's own.
- **The issue bodies are numbered two behind their issue numbers.** Every body refers to "piece N" where piece N is issue **N+2**. The `Depends on #N` lines use real numbers and are correct; only the prose is off by two. Not fixable by filing: parked bodies cannot be rewritten from a survey. Read `Depends on:` first.
- **The decision recorded on #1 has landed in the docs.** TR-4 carries the edit-and-delete rule, the expense form in `docs/ui.md` reopens from the stored rule, ADR-0011 records the split rule stored beside its shares. A copy of the pre-decision sentence outside #7's quoted stale text is drift — report it if seen.
- **`.sdlc/memory/project.md` is stale in the known way.** It still says no code exists and all verbs are stubs; `src/` exists and three verbs are real since #3. The Librarian updates it nightly from what merged — do not file an issue about it. Same for any QA-memory stubs.
- **#20's items must be checked for reproduction before planning.** They were written against PR #19 as it stood; a later round may have fixed one. Drop what does not reproduce rather than implementing what was never wrong.

## What this survey considered and did not file

Recorded so the next run does not re-derive them and file them as if new.

- **A cross-piece "ledger never drifts" test** (record → edit → pay → delete → balances return to zero). Each seam is already owned: #6 property-tests the split sum, #7 asserts a rounding-rule change leaves stored balances byte-identical, #8 asserts a balance is a sum of stored rows, #9 asserts a deleted payment restores exactly what it moved. Revisit only if a piece drops its invariant test.
- **A warning that the write-path-only split function must never run on a read path.** #8's body and AC-4 already name it, and ADR-0011 exists. Restating it would be noise at the point of danger.
- **Fixing the piece-numbering drift or the stale memory notes.** Unfillable in principle: parked bodies cannot be rewritten, and no ticket may deliver a change to `.sdlc/memory/`.
