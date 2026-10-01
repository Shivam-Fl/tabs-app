# Tabs — product requirements

Shared expenses for friends, flatmates and trips: who paid, who owes, and the fewest payments
that settle everyone up. A Splitwise-class web app, ready for real users.

This repository starts empty. Everything in it — the architecture, the code, the tests, the
deployment — is built from this document.

## Hard constraints

- **TypeScript, one Next.js (App Router) application**, deployed on **Vercel**. Everything runs
  there — serverless functions, no long-running process, no local disk that outlives a request.
- **Postgres, with zero setup locally.** With `DATABASE_URL` set (production: Neon, added from
  Vercel's Storage tab) the app uses that database. With it unset, the app runs on an embedded,
  in-process Postgres (PGlite) so `npm run dev`, the test suite, CI and browser QA need nothing
  installed and no account anywhere. The same migrations run on both, applied automatically on
  start in development and on deploy in production. Nothing a user saves may be lost on a
  redeploy or a cold start.
- **Real accounts.** Every read and write of a group's data is checked, on the server, against
  who is asking.
- **Money is exact.** Integer minor units end to end, never floats; a split never loses or
  invents a paisa — the parts always sum to the whole, and the remainder rule is stated and
  tested.
- **Secrets only from environment variables**, each documented in the README. In development
  and CI, with nothing set, the app boots on safe local defaults and logs that it is doing so; in
  production a missing required secret stops it with a message naming the variable.

## Users and accounts

- Sign up and sign in with email and password. Passwords are hashed with a slow, salted hash;
  sessions are secure, http-only cookies; signing out ends the session on the server.
- Failed sign-ins are rate-limited. Error messages never reveal whether an email is registered.
- A profile: display name and default currency.

## Groups and members

- Create a group with a name, a currency and an optional type (trip, home, couple, other).
- **Invite by link:** the owner shares a join link; anyone signed in who opens it joins the
  group. The owner can turn the link off or make a new one, which kills the old.
- **Placeholder members:** a member can be added by name before they have an account, so a trip
  can be recorded before everyone signs up. Someone joining through the link can claim a
  placeholder, and everything recorded for it becomes theirs.
- Roles: the creator is the owner; the owner can rename the group, remove members, and archive
  the group. A member with a non-zero balance cannot be removed until it is settled.
- Any member can leave a group whose balance for them is zero.
- A user sees only the groups they belong to.

## Expenses

- An expense has a description, an amount, a date, who paid, and how it is split. Optional: a
  category (food, travel, rent, utilities, shopping, entertainment, other) and a note.
- **Who paid:** one member, or several members each paying part (the parts sum to the total).
- **Split types:** equally among chosen members; by exact amounts; by percentages; by shares.
  Each is validated — exact amounts must sum to the total, percentages to 100 — with the error
  naming what is off and by how much. Members can be left out of a split.
- The rounding remainder of an equal, percentage or share split goes to a stated member (the
  first payer), so the parts always sum to the whole.
- Any member can edit or delete an expense. Every change is recorded in the activity feed with
  who made it and what changed.
- Expenses list newest first, filterable by member and category, searchable by description.

## Balances and settling up

- Per group: each member's net balance, and the simplified debts — who pays whom, in as few
  transfers as the algorithm achieves (state which algorithm, and what it guarantees).
- Across groups: on the home screen, "you owe" and "you are owed" in total and per person.
- **Settle up:** record a payment from one member to another, in full or in part. It moves the
  balances and appears in the feed. A payment can be deleted by the members it involves.
- A group whose balances are all zero says so clearly.

## Activity

- A feed per group and one across all of a user's groups: expense added, edited, deleted;
  payment recorded; member joined, left or removed — each with who and when.

## Experience

- A product people would choose to use: clean, modern and consistent, not a prototype.
- Mobile-first and responsive; it works well on a phone browser and on a laptop.
- Every page has one h1 and a clear heading hierarchy, labelled controls, keyboard access and
  visible focus. Empty, loading and error states are designed, not left blank.
- Amounts are shown in the group's currency with the correct symbol and separators.
- Fast: the main screens load in under a second on an ordinary connection.

## Operations

- A health endpoint that checks the database is reachable.
- A seed for development and for QA: a few users with known passwords, groups with expenses of
  every split type, a multi-payer expense, payments, and a placeholder member.
- The README says how to run it locally (one command) and how to deploy to Vercel from scratch:
  which database to add, which environment variables to set, and how migrations run.

## Not in this version

Password reset and account deletion. Native mobile apps. Paying through the app (UPI, cards).
Receipt photos and scanning. Recurring expenses. Multiple currencies inside one group, and
exchange rates. Charts and spending reports. Email notifications. These are later, and the
design should not make them hard — but none of them is built now.

## Order of work

1. The application skeleton on Vercel's shape, the database layer (PGlite locally, Postgres in
   production) with migrations, accounts and sessions, and the health endpoint.
2. Groups: create, invite links, placeholder members and claiming, roles, leave and remove.
3. Expenses with multiple payers, all four split types, categories, edit and delete.
4. Balances, simplified debts and settle-up with partial payments; balances across groups on
   the home screen.
5. The activity feed, search and filters, the seed, and the README's deploy guide.
