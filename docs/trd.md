# Technical requirements

_Generated from `project-brief.json` for #1. Edit the brief, not this file._

## Requirements

### TR-1 — Every read and write of a group's data is authorised on the server against the session that is asking, expressed as a membership join inside the query itself. A non-member receives 404 and no data; an unauthenticated request is redirected to sign-in.

**Why.** The spec requires that every read and write of a group's data is checked on the server against who is asking, and that a user sees only the groups they belong to. Expressing authorisation in the query rather than as a separate check means a call site cannot forget it, which is the way this class of bug is actually introduced.

**Priority.** must

**Proved by.** Integration test: a second user requesting a group they do not belong to gets 404 on every read route and no row is written by any action. A request with no session redirects.

### TR-2 — Every amount is a bigint count of minor units from the database column to the formatted string. No float is ever assigned to, stored in, or returned for a money value, and a money-typed value cannot be given a number without a type error.

**Why.** The spec makes money exact end to end, never floats. A float would make a 0.1 split inexact in a way that is invisible until two people's balances disagree by one paisa and neither can say why.

**Priority.** must

**Proved by.** A lint or type rule making number unassignable to a money type, and a property test asserting every computed amount is an integer.

### TR-3 — The parts of every split sum exactly to the expense total. Exact-amount splits that do not sum to the total and percentage splits that do not sum to 100 are rejected, with the error naming what is off and by how many minor units. Equal, percentage and share splits assign their entire floor-division remainder to the first payer in the split's member order, and the sum is asserted before the write commits.

**Why.** The spec requires each split type to be validated with an error naming what is off and by how much, and requires the remainder rule to be stated and tested so the parts always sum to the whole. This is the requirement the whole product's trustworthiness rests on.

**Priority.** must

**Proved by.** Unit tests over all four split types including a 1-minor-unit total split three ways and a total of 7 units split four ways, plus property tests over 10,000 random totals asserting the sum invariant and the stated recipient of the remainder.

### TR-4 — A member's net balance in a group equals their total paid minus their total share, summed from the stored expense_payer and expense_share rows alone; a balance is never derived from the expense's stored split rule. Editing or deleting an expense replaces that expense's stored payer and share rows in the same transaction that writes its activity entry, so balances move by exactly the difference the replacement makes, and no balance changes except through a write to that expense or to a payment. A change to the split algorithm or to the rounding rule never re-evaluates stored history: an expense keeps the shares it was written with until somebody edits or deletes it.

**Why.** The spec requires balances to follow from what was recorded, requires a member's records to become theirs when they claim a placeholder, and requires every expense to be editable and deletable. Those together mean an edit is a legitimate change to the ledger: the stored rows are the ledger, replacing them is the edit, and the difference is what balances move by. Storing the split rule as well is what lets the edit form reopen showing exactly what was entered, and it is kept out of the balance path so that a later change to how splits are computed cannot restate what people already owed — which is the one thing this product must never do.

**Priority.** must

**Proved by.** Integration test: record an expense with two payers and an equal split, then edit its amount, payers, participants and split type in one save; assert every member's balance moved by exactly the difference implied by the replacement rows, that exactly one activity entry was written naming each of amount, payers, participants and split type, and that reopening the edit form shows the inputs exactly as saved. A second test changes the rounding rule and asserts every stored balance is byte-identical before and after.

### TR-5 — An expense records one payer or several, and where there are several each payer's part is stored and the parts sum exactly to the expense total; a set of parts that does not sum is rejected with the discrepancy named in minor units.

**Why.** The spec requires several members each paying part, with the parts summing to the total, and a multi-payer expense is explicitly required in the QA seed.

**Priority.** must

**Proved by.** Unit and integration tests for a single payer, two payers summing to the total, and two payers that do not.

### TR-6 — Simplified debts are produced by greedy largest-creditor against largest-debtor matching over the per-member net balances. The result sums to zero, uses at most n − 1 transfers where n is the number of members with a non-zero balance, and is deterministic: the same balances always yield the same transfers.

**Why.** The spec asks for the fewest payments the algorithm achieves and asks us to state which algorithm and what it guarantees. The true minimum is a subset-sum partition and is not solvable in polynomial time, so the guarantee stated is the one greedy actually provides, and it is stated rather than implied.

**Priority.** must

**Proved by.** Unit tests including a six-member fixture with a known answer, asserting the transfer count, that the transfers reproduce the net balances exactly, and that two runs on the same balances produce identical output.

### TR-7 — A payment is a first-class record from one member to another, in full or in part, that moves both balances by its amount, appears in the group's feed, and can be deleted only by one of the two members it involves — after which the balances it moved are restored.

**Why.** The spec requires settle-up with full and partial payments, requires a payment to move the balances and appear in the feed, and restricts deletion to the members involved. Restoring the balances on delete is the part that makes the feed and the money agree.

**Priority.** must

**Proved by.** Integration test recording a partial payment, asserting both balances moved by exactly its amount, then deleting it as an involved member and asserting both balances return; asserting a third member is refused the delete.

### TR-8 — The home screen reports what the signed-in user owes and is owed in total and per person, across every group they are an active member of, and those totals equal the sum of the per-group balances.

**Why.** The spec requires the across-groups view on the home screen, and a total that disagrees with the groups it summarises is worse than no total.

**Priority.** must

**Proved by.** Integration test across a user in three groups, asserting the total equals the sum of the per-group net balances to the minor unit, and excluding a group the user has been removed from.

### TR-9 — A group in which every member's balance is zero says so plainly, on the group balance screen and on the group overview, rather than showing an empty transfer list.

**Why.** The spec requires this explicitly, and it is the screen a group visits most often at the end of a trip, when the answer is 'you are done'.

**Priority.** must

**Proved by.** QA, plus a component test rendering the group screen against a settled fixture and asserting the settled state is present.

### TR-10 — Sign-up and sign-in with email and password. The password is stored only as a salted scrypt hash; the session is an opaque random token in an httpOnly, Secure, SameSite=Lax cookie whose SHA-256 is the only thing persisted; signing out deletes the session row on the server and clears the cookie. Sessions expire and a signed-out session does not work even if the cookie is replayed.

**Why.** The spec requires email and password, a slow salted hash, secure httpOnly cookies, and signing out ending the session on the server. Hashing the token at rest means a database disclosure does not hand over live sessions.

**Priority.** must

**Proved by.** Integration test asserting the raw cookie token appears nowhere in the database, that signing out then replaying the cookie is unauthenticated, and that an expired session is refused.

### TR-11 — Failed sign-ins are rate-limited per account and per source address, and the status and response body for an unknown email are byte-identical to those for a wrong password, including when the request is rate-limited.

**Why.** The spec requires rate limiting and requires that error messages never reveal whether an email is registered. A limit that distinguishes the two cases is an enumeration oracle however carefully the message is worded.

**Priority.** must

**Proved by.** Test comparing the two responses byte for byte, and asserting the sixth failed attempt in the window is refused while a correct password on the seventh is accepted.

### TR-12 — A profile holds a display name and a default currency, both editable, and the default currency is the currency a group the user creates is created in.

**Why.** The spec requires a profile of exactly these two things, and the default currency is what makes group creation one field fewer on the common path.

**Priority.** must

**Proved by.** Integration test: change the default currency, create a group, assert its currency; change the display name, assert it appears wherever the user is shown.

### TR-13 — A group has a name, a currency and an optional type (trip, home, couple, other). Exactly one member is the owner. Only the owner may rename the group, remove a member, or archive it. A member whose balance is non-zero may not leave or be removed, and a user sees only the groups they belong to.

**Why.** The spec states each of these, and the balance precondition is the one that keeps a group's arithmetic intact — removing someone mid-settlement would leave a debt attributed to a person who is no longer in the group.

**Priority.** must

**Proved by.** Integration test matrix over owner and member roles for each of the four operations, and over leaving and being removed with a zero and a non-zero balance.

### TR-14 — An invite link lets any signed-in user join the group. Opening a join link twice is a no-op rather than a second membership. The owner can disable the link, or rotate it, and rotation invalidates the previous token immediately.

**Why.** The spec requires invite by link, joining by opening it, turning the link off, and making a new one that kills the old. The idempotence matters because people refresh and re-share links.

**Priority.** must

**Proved by.** Integration test: open a link twice, assert one membership; rotate, assert the old token is rejected and the new one works; disable, assert the token is rejected.

### TR-15 — A placeholder member can be created by name before having an account, so a trip can be recorded before everyone signs up. Claiming is atomic: when two people claim the same placeholder at once, exactly one succeeds and the other is told it is already claimed. Everything recorded against the placeholder belongs to the claimer from that point, and a placeholder that is already claimed cannot be claimed again.

**Why.** The spec requires placeholder members and that everything recorded for one becomes the claimer's. The race is the whole difficulty: without an atomic claim two people can end up sharing one placeholder's history, which is unrecoverable.

**Priority.** must

**Proved by.** Integration test firing two concurrent claims and asserting one success and one conflict, then asserting the expenses recorded before the claim are attributed to the winner.

### TR-16 — Removing a member ends their membership but keeps their stored shares and payer records, so every other member's balance is unchanged by the removal and the group's history still reads correctly.

**Why.** The spec allows a member to be removed once settled and requires the feed to record it. Discarding their records would restate everyone else's balance, which TR-4 exists to prevent.

**Priority.** must

**Proved by.** Integration test comparing every member's balance immediately before and after a removal, and asserting the removed member's expense still appears in the group's list with them named.

### TR-17 — Every mutation writes exactly one activity entry in the same transaction as the change: there is no state change without a feed entry, and no feed entry without the state change.

**Why.** The spec requires every change to be recorded in the feed with who made it and what changed. A feed written outside the transaction is the classic source of entries describing changes that were rolled back.

**Priority.** must

**Proved by.** Integration test that forces a failure after the write and asserts no entry was written, and a test asserting exactly one entry per successful mutation across all mutation types.

### TR-18 — Expenses list newest first by date, filter by member and by category, and search by description; a filter and a search compose, and an empty result set distinguishes 'no expenses match' from 'no expenses yet'.

**Why.** The spec requires the list newest first, filterable by member and category, and searchable by description. The distinction between no matches and no expenses is what stops the empty state looking like a bug.

**Priority.** must

**Proved by.** Integration test over a seeded group asserting the ordering, each filter, the composition, and both empty variants; QA on the screen.

### TR-19 — The activity feed exists per group and across all of a user's groups, records expense added, edited and deleted, payment recorded, and member joined, left or removed, each with the actor and the time, and is ordered newest first.

**Why.** The spec requires both feeds with these event kinds. The cross-group feed is what makes the product useful to someone who does not open each group.

**Priority.** must

**Proved by.** Integration test performing each of the seven event types and asserting the feed contains each with actor and time in the right order, scoped correctly to a non-member.

### TR-20 — GET /api/health executes a real query against the configured database and returns 200 with the round-trip time, or 503 naming the failure without leaking the connection string. It is what sdlc:ready polls.

**Why.** The spec requires a health endpoint that checks the database is reachable, and the pipeline's readiness poll needs an endpoint whose 200 actually means the app can serve a request. An endpoint that returns 200 without touching the database reports a healthy app that cannot answer anything.

**Priority.** must

**Proved by.** Integration test asserting 200 and a positive round-trip time against a live database, and 503 when the database is unreachable. sdlc:ready exits 0 only on 200.

### TR-21 — With DATABASE_URL set the application uses that Postgres; with it unset it runs on an in-process PGlite. The same migration list is applied to both, on start in development and on deploy in production, behind a lock so that two concurrent cold starts cannot apply a migration twice. Applying the migrations to an up-to-date database is a no-op.

**Why.** The spec requires the PGlite fallback with zero local setup and the same migrations on both, applied automatically in development and on deploy. The lock is what makes 'on deploy' safe when several function instances start at once.

**Priority.** must

**Proved by.** Integration test: run the migrator against a fresh in-memory PGlite, assert the schema exists, run it again and assert no migration is re-applied. The Neon path is covered by a preview deployment check, not by a test.

### TR-22 — In production a missing required environment variable stops startup with a message naming that variable. In development and CI, with nothing set, the application boots on documented local defaults and logs that it is doing so.

**Why.** The spec requires secrets only from environment variables, each documented in the README, with a loud failure in production and a safe, logged default elsewhere. Failing silently in production is how an app ships with a development secret.

**Priority.** must

**Proved by.** Test asserting production boot fails naming the variable, and that a default boot logs which defaults it is using.

### TR-23 — Every amount is rendered with the group's currency symbol, separators and fraction digits through Intl.NumberFormat, and is never rendered from a float. A negative balance is presented as a direction — you owe, or you are owed — not only as a minus sign.

**Why.** The spec requires correct symbol and separators, and a group that is owed money should read that way rather than as a negative number, which is the same number but the wrong story.

**Priority.** must

**Proved by.** Snapshot test over a table of currencies including zero- and three-fraction-digit ones, and a component test asserting the direction wording for both signs.

### TR-24 — Every page has exactly one h1 and a correct heading order, a label for every control, a visible focus ring, and is fully operable by keyboard. Empty, loading and error states are rendered for every screen that can reach them; a screen that cannot reach one says why in the brief rather than leaving it blank.

**Why.** The spec requires clean heading structure, labelled controls, keyboard access, visible focus, and designed empty, loading and error states. QA checks these on every screen, so a screen that has not decided them will be reported as a defect.

**Priority.** must

**Proved by.** QA against the accessibility list in ui.accessibility, plus a component test per screen asserting its empty and error states render.

### TR-25 — The home, group, expenses and balances screens respond in under one second at p75 on an ordinary connection, measured against the production build rather than the dev server.

**Why.** The spec requires the main screens to load in under a second on an ordinary connection. Measuring against `next dev` would measure the development compiler rather than the product, which is the measurement that always flatters.

**Priority.** should

**Proved by.** Timing recorded in the QA report against the compose build; a regression over 1 second at p75 opens a bug.

### TR-26 — npm run sdlc:seed creates, through the running application, a fixed set of users with known passwords, groups containing one expense of every split type, a multi-payer expense, payments, and an unclaimed placeholder member. Running it twice produces the same state, and it refuses to run in production.

**Why.** The spec requires exactly this seed for development and for QA, and QA must never touch real records. Idempotence is what makes a QA run reproducible and what makes a failed run recoverable by re-seeding.

**Priority.** must

**Proved by.** Integration test seeding twice and comparing the resulting rows, and asserting the endpoint refuses when NODE_ENV is production.

### TR-27 — The README documents every environment variable with its purpose and whether it is required, one command to run the application locally with nothing installed, and the Vercel deploy from scratch: which database to add, which variables to set, and how migrations run.

**Why.** The spec requires the README to say how to run it locally in one command and how to deploy to Vercel from scratch. The secret requirement names the README as the place variables are documented, and this brief adds a ticket nobody would otherwise write.

**Priority.** must

**Proved by.** A human follows both on a clean machine; the reviewer checks the README against the variables the code actually reads.

## Data model

### user

An account: id, lowercased unique email, password hash, display name, default currency, created_at.

**Keys.** Primary key id (UUID). Unique index on lower(email).

### session

A live sign-in: id, user_id, the SHA-256 of the session token, created_at, expires_at, and the moment it was revoked.

**Keys.** Primary key id. Unique index on token_hash. Index on user_id. The raw token is never stored.

Deleting the row is what ends the session on the server; clearing the cookie alone would not.

### login_attempt

A failed sign-in for rate limiting: a key that is the hash of the email and source address together, the window it falls in, and the count.

**Keys.** Primary key on the key. Database-backed rather than in memory, because a per-instance counter resets on every Vercel cold start and bounds nothing.

### group

A shared expense group: id, name, currency, optional type, owner_user_id, archived_at, and the invite link's token and whether it is enabled.

**Keys.** Primary key id. Unique index on invite_token where not null. Exactly one owner_user_id, which is also a member row.

### member

One person's place in a group: id, group_id, user_id (null while the member is a placeholder), display_name, role, and removed_at.

**Keys.** Primary key id. Partial unique index on (group_id, user_id) where user_id is not null, so a user cannot join twice and a placeholder is not a membership collision.

Removal sets removed_at rather than deleting the row. The shares and payer records that point here stay, which is what keeps other members' balances correct.

### expense

Something that was paid for: id, group_id, description, amount_minor, the group's currency carried on the row, split_type (equal, exact, percentage or shares), optional category and note, the date it happened, who created it, and created_at, updated_at, deleted_at.

**Keys.** Primary key id. Indexed on (group_id, date desc) for the list, and on description for search.

split_type names the rule that was entered and the per-member inputs are in expense_split_input; the amounts that rule produced are in expense_share, and those are the only two tables a balance reads. Both rule-shaped tables are replaced wholesale when the expense is edited.

### expense_payer

One member's part of an expense's total: expense_id, member_id, amount_minor.

**Keys.** Composite primary key (expense_id, member_id). The parts sum exactly to the expense total.

### expense_share

One member's resulting share of an expense: expense_id, member_id, amount_minor, computed once when the expense is written.

**Keys.** Composite primary key (expense_id, member_id). The shares sum exactly to the expense total.

Together with expense_payer this is the whole ledger: a balance is a sum over these rows and is never a re-evaluation of the stored split rule. An edit replaces both sets of rows in one transaction rather than adjusting them.

### expense_split_input

One member's place in the split, with the number that member was given: expense_id, member_id and input_value. The row's existence is the record that this member was included in the split.

**Keys.** Composite primary key (expense_id, member_id). input_value is minor units for an exact split, hundredths of a percent for a percentage split and a plain count for a shares split, because the unit is fixed by the expense's split_type; it is null for an equal split, where the only stored input is membership.

Written and replaced with the expense; never read to compute a balance. It exists so the edit form reopens showing exactly what was entered — which members were included, in what order, and the numbers typed for them — and so an edit's activity entry can name which of amount, payers, participants and split type changed. A member removed from a split has their row deleted, not zeroed.

### payment

A recorded settlement: id, group_id, from_member_id, to_member_id, amount_minor, optional note, who recorded it, created_at, deleted_at.

**Keys.** Primary key id. Indexed on group_id. Both members are group members; the payment moves both balances by its amount.

### activity

One entry in the feed: id, group_id, actor_user_id, kind, subject_type, subject_id, a jsonb detail of what changed, created_at.

**Keys.** Primary key id. Indexed on (group_id, created_at desc) and on (actor scope, created_at desc) for the cross-group feed.

Written in the same transaction as the change it describes, always through src/lib/activity.ts. An expense-edited entry names each field that moved — amount, payers, participants, split type — with its old and new value, comparing the stored rule rows (split_type and expense_split_input) against the amounts, and omits the fields that did not change.

### drizzle migrations

The applied-migration history, maintained by drizzle-kit's migrator, in the same database whichever backend is configured.

**Keys.** The table drizzle-kit creates and manages. Applying the list to an up-to-date database is a no-op.

## Interfaces

### GET /api/health

```
Returns 200 with { status: 'ok', database: 'ok', latencyMs: number } after executing a real query, or 503 with { status: 'error', database: 'error', message: string }. The message names the failure and never contains the connection string.
```

**On failure.** 503 when the database does not answer within the timeout. The endpoint never throws: an unreachable database is a reported 503, not a 500, because the caller is a poll and a 500 reads as an application bug.

**Idempotency.** A read. Safe to call as often as the poll does.

### POST /api/dev/seed

```
Rebuilds the fixture set and returns { ok: true, users: [{ email, password }], groups: n }. Takes no parameters; the fixture set is fixed in the repository so that every run is the same run.
```

**On failure.** 409 with a message when the request does not come from localhost, and 403 with the variable name when NODE_ENV is production — the guard is a security requirement, not a convenience, because this endpoint writes.

**Idempotency.** Yes, by resetting: it truncates and rebuilds rather than appending, so seeding twice gives the same state and a failed QA run is recovered by re-seeding.

### scripts/seed.mjs

```
The command sdlc:seed runs. Waits for GET /api/health, then POSTs to /api/dev/seed and prints the fixture credentials on success. Written in plain JavaScript so it runs under a clean node with no build step.
```

**On failure.** Non-zero exit with the endpoint's message, which is what makes a failed seed visible in the QA boot log rather than a silent empty database.

**Idempotency.** Delegates to the endpoint, which is idempotent.

### src/lib/auth.requireUser()

```
The module boundary every page and every Server Action calls first. Returns the signed-in user, or redirects to sign-in. Takes no arguments on purpose: a caller cannot supply a user id and so cannot act as someone else.
```

**On failure.** Redirects to sign-in when there is no valid session. Throws nothing for an expected case.

**Idempotency.** A read. Cheap enough to call on every render; it is one indexed lookup on a hashed token.

### src/lib/access.requireMember(groupId)

```
The authorisation boundary for group data. Returns the caller's membership row, or 404. The membership join is expressed in the same query that reads the group's rows, so there is no window between the check and the read.
```

**On failure.** 404, not 403, when the caller is not a member: whether a group exists is itself information. 403 only when the caller is a member and the action is the owner's alone.

**Idempotency.** A read.

### src/lib/money

```
The module boundary for money. parseMajorUnits(text, currency) to bigint minor units, formatMinorUnits(bigint, currency) to a display string, and split(amount, type, participants) returning the per-member bigint shares and the remainder recipient, or a typed validation error naming the discrepancy.
```

**On failure.** Returns typed errors rather than throwing, so a Server Action can render a split error next to the field that caused it and can name the exact shortfall in minor units.

**Idempotency.** A pure function. No database, no clock, no randomness.

### src/lib/balances

```
netBalances(members, payers, shares) returning a bigint per member, and simplifyDebts(balances) returning the ordered transfers greedy produces. Both take data in and return data; neither touches the database, so both are directly testable and neither is reachable from a request without going through access.requireMember first.
```

**On failure.** simplifyDebts throws on balances that do not sum to zero, which is a programming error rather than a user error and must never reach a user as a 500 — the integration test asserts the sum before it is called.

**Idempotency.** A pure function of its arguments, and deterministic for a given set of balances.

## Non-functional

- The home, group, expenses and balances screens respond in under 1 second at p75 on an ordinary connection, measured against the production build.
- GET /api/health returns within 300ms at p95 with a warm database, and within 2 seconds when the database is unreachable — a health check that hangs is a health check that lies.
- A sign-in performs exactly one scrypt derivation (N = 2^17, r = 8, p = 1) and no more, costing roughly a quarter second and 128 MB at peak, which is what the rate limiter bounds.
- No request path issues more than one authorisation query, and that query is the one that fetches the data — there is no separate check-then-fetch pattern anywhere in src/app.
- No float is ever assigned to a money value, enforced by a lint rule rather than by review.
- The application writes nothing to local disk in production: the only durable state is the configured database.
- Every mutation is a single transaction, so a partially applied change is not a state the product can be in.
- The whole dependency tree installs and typechecks with install scripts disabled, which is what the repository's CI does to every pull request.
- The application runs only on the Node.js runtime, never the Edge runtime, because the database Pool is a process-level singleton.
