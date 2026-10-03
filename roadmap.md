# Roadmap

Rebuilt 2026-10-03 from `maintainer/issues.json` (9 open, 0 untrusted), `maintainer/pulls.json` (3 open), `maintainer/closed.json` (11 closed recently). Previous survey's roadmap was `maintainer/roadmap.md`.

## Shipped

What a person can do now that they could not before:

- **Sign up, sign in, and stay signed in.** Email/password accounts with salted scrypt hashes, opaque httpOnly session cookies, server-side sign-out, rate-limited sign-in, a health endpoint backed by a real database query, and migrations applied on boot on either backend (PGlite locally, Neon with `DATABASE_URL`). (Closed #3, plus its follow-ups #17.)
- **Create a group, see who is in it, and manage membership.** Name, currency, optional type, exactly one owner; owner-only rename, remove, and archive; leave and remove refused while a balance is non-zero; a user sees only groups they belong to. (Closed #4, plus its follow-ups #20-tracked review items still open.)
- **Invite people by link, and record a name before they sign up.** Idempotent join links the owner can disable or rotate with immediate invalidation, plus placeholder members with an atomic claim so everything recorded against the name becomes the claimer's. (Closed #5, plus its follow-ups #23, #26.)
- **Record an expense: who paid, and how it splits.** One payer or several with parts summing exactly to the total, all four split types with the remainder rule stated and asserted before commit, categories, integer-minor-unit money end to end. (Closed #6, plus its follow-ups #27, #30.)
- **Edit or delete an expense, and say exactly what changed.** The edit form reopens from the stored split rule showing what was typed, the activity entry names each field that moved, and balances move by exactly the replacement difference in one transaction with the entry. (Closed #7, plus its follow-up #33.)

## In flight

- **#8 See who owes whom, in as few payments as possible** — open PR #31 from `sdlc/issue-8`, labelled `sdlc:needs-human`. Read-only balances over stored payer/share rows, greedy largest-creditor simplified debts, home-screen across-group totals, settled-state wording, and the balance-guarded leave/remove rules. Head of the remaining chain: #9 is parked on it.
- **#20 Follow-ups from #4: 5 from the review** — open PR #21 from `sdlc/issue-20`, labelled `sdlc:needs-human`. Five non-blocking review findings from PR #19 (sub-unit negative sign in `formatMinor`, `readMembers` two-step auth, RemoveButton and rename form missing `router.refresh()`, one unlisted file in the work order). Blocks nothing; its `formatMinor` item bites as soon as #8 renders real balances.
- **Memory maintenance PR #35** (`memory/2026-10-03`) — not product work; the Librarian's nightly pass. No agent action.

Everything else open is parked behind the chain, not stalled: #9 on #8; #10, #11, #12 on #9. #14 (Spec coverage) and #15 (pipeline self-fixes) are bookkeeping, not product work.

## Next

1. **Land #8, then run #9.** #9 (record a payment; delete restores exactly what it moved) reads #8's net balances and closes the money loop. The delete-restore is the riskiest write left, so it goes first even though #10 looks smaller.
2. **Then #10.** Search, filters, and both activity feeds render entries every earlier piece wrote — including #9's payments — in one read-only work order. It is the last user-visible product work; landing it means every screen a person sees exists.
3. **Then #11, then #12.** #11's fixed seed gives QA known-password users and the fixture data for every money screen, which is also what finally makes `qa_auth.mode: fixture` possible. #12 (README, deploy guide, p75 timings against the production build) closes operations and genuinely needs every screen to exist first, plus a human on a clean machine.

## Blocked, and on whom

None of these is agent work. All sit with a person, and none can be filed as an issue because `.sdlc/config.yml` is a reserved path no ticket branch may edit.

- **QA cannot test most of the product** — `qa_auth.mode` is `none`, so QA arrives signed out. `fixture` is the right setting (compose mode and the local-only allowlist already hold), but it only becomes possible when **#11** lands the seed's known-password users. **On: the repository owner, after #11 merges.**
- **No Vercel project and no Neon database exist.** Nothing deploys; #12's deploy guide and its Neon claims are proved by a human opening a preview, not by QA. **On: the repository owner.**
- **`env.mode: compose` versus `preview`** — compose proves the production build against local PGlite and says nothing about the Neon path; preview proves Neon and needs a preview-scoped `DATABASE_URL` that is never production. **On: the repository owner.**
- **Which currencies must be supported at launch** — #4 assumed any ISO 4217 code via `Intl`. A fixed short list would close the picker and let the README say so. Decide before #12. **On: the repository owner.**
- **#15's refused self-fix waits on a secret** — the framework source could not be read without the `SDLC_FRAMEWORK_TOKEN` secret. **On: the repository owner.**
- **#8 and #20 wait on a person by label** (`sdlc:needs-human`) while their PRs (#31, #21) are open. **On: whoever triages those tickets.**

## Epics

- #1 Build Tabs from the spec (docs/spec/tabs.md) — in flight (5 of 10 children closed: #3, #4, #5, #6, #7).

EPIC DEPENDENCY GRAPH (one line per open epic):

- #1 waits on nothing; it is the only open epic, so there are no `epic_links`.

Dependency graph between its open children, so the next run does not re-derive it:

```
#8 (in flight, PR #31) ──▶ #9 ──┬──▶ #10 (search, filters, activity)
                                ├──▶ #11 (seed)      [unblocks QA auth]
                                └──▶ #12 (README, deploy, perf)
#20 (in flight, PR #21) — follow-up to closed #4, blocks nothing
```

### Spec coverage

#14 reports 11 sections: 1 built, 7 in flight, 2 not started, 1 non-goal. Its per-section table still names closed #6/#7 as "in flight" — bookkeeping lag after this week's merges, not a defect to file. Substance: **every TR-1..TR-27 is claimed** by at least one open or recently closed child (#8 covers TR-6/8/9/13/16, #9 covers TR-7/17, #10 covers TR-18/19, #11 covers TR-26, #12 covers TR-22/25/27), and S-2..S-10 are each carried. **No uncovered spec remains**, so no Spec coverage issue is filed. When the last child of #1 closes, #1 closes with nothing dropped.

## Notes for the next run

- **Zero `untrusted` issues** in this survey's input. All 9 open issues are the pipeline's own.
- **The issue bodies are numbered two behind their issue numbers.** Every body refers to "piece N" where piece N is issue **N+2**. The `Depends on #N` lines use real numbers and are correct; only the prose is off by two. Not fixable by filing: parked bodies cannot be rewritten from a survey. Read `Depends on:` first.
- **The replan-project decision on #1 (by @Shivam-Fl, 2026-10-01) has landed in the docs.** TR-4 carries the edit-and-delete rule, the expense form in `docs/ui.md` reopens from the stored rule, ADR-0011 records the split rule stored beside its shares. A copy of the pre-decision sentence outside #7's quoted stale text is drift — report it if seen.
- **`.sdlc/memory/project.md` is stale in the known way.** It still says no code exists and all verbs are stubs; `src/` exists and the product has shipped through #7. The Librarian updates it nightly from what merged — do not file an issue about it. Same for any QA-memory stubs.
- **#20's items must be checked for reproduction before planning.** They were written against PR #19 as it stood; a later round may have fixed one. Drop what does not reproduce rather than implementing what was never wrong.

## What this survey considered and did not file

Recorded so the next run does not re-derive them and file them as if new.

- **Nothing new.** Every remaining product gap is already an open child of #1 (#8, #9, #10, #11, #12), and the known follow-ups are already #20. Filing anything else this run would be noise.
- **A cross-piece "ledger never drifts" test** (record → edit → pay → delete → balances return to zero). Each seam is already owned: #6 property-tests the split sum, #7 asserts a rounding-rule change leaves stored balances byte-identical, #8 asserts a balance is a sum of stored rows, #9 asserts a deleted payment restores exactly what it moved. Revisit only if a piece drops its invariant test.
- **A warning that the write-path-only split function must never run on a read path.** #8's body and AC-4 already name it, and ADR-0011 exists. Restating it would be noise at the point of danger.
- **Fixing the piece-numbering drift or the stale memory notes.** Unfillable in principle: parked bodies cannot be rewritten, and no ticket may deliver a change to `.sdlc/memory/`.
