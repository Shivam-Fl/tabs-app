# Product requirements

_Generated from `project-brief.json` for #1. Edit the brief, not this file._

## The problem

A group that shares money — a flat, a trip, a household — keeps its accounts in a group chat, a shared note or someone's memory, and the arithmetic goes wrong. Someone who was owed money forgets, or the group informally agrees that the last two small amounts do not matter and stops keeping score. The result is not a wrong number so much as an unsettled relationship: people avoid raising it, and the expenses keep accumulating anyway. The specific failure this product addresses is that there is no cheap, trustworthy way for a group to record what was actually paid, see who owes whom without doing arithmetic in a chat window, and know that the answer is final — that the split is exact, that the number has not changed since the money was spent, and that settling up is recorded rather than remembered.

## Who has it

### Flatmates sharing rent, bills and groceries

- **When:** Monthly, on a phone, at a kitchen table or in a group chat, adding an expense within a day or two of it happening and checking balances occasionally in between.
- **Pain:** Rent and utilities dominate the ledger and everything else is small and messy. Nobody wants to chase a flatmate for the 40 units of groceries, and nobody trusts a number they cannot reproduce.
- **Sophistication:** Low. They will use it because it is in the chat they already use, not because it is powerful. Every screen has to work on a phone with one hand.

### A group on a trip

- **When:** A week or two away, several people, some of whom have never met each other, often with a mix of currencies paid on the way and one settled in the middle.
- **Pain:** The group forms and dissolves fast, and the trip is over before anyone reconciles. Adding a member after money has been spent is normal, and nobody wants to hand-enter a spreadsheet.
- **Sophistication:** Low to moderate. They need the trip recorded as it happens and a clear answer at the end, and they do not need it to be pretty — they need it to be finished.

### One person keeping track for a couple or a small shared project

- **When:** Occasionally, on a laptop, reconciling a period after the fact, sometimes for someone else.
- **Pain:** They are the only one who cares about the arithmetic, which is exactly the arrangement that makes the other person never learn where the money went. It has to be legible to the person who is not keeping track.
- **Sophistication:** Moderate. They will look at the balances and the feed to explain a number to someone else, so the explanation has to be on the screen and not in their head.

## Jobs to be done

- Record an expense while it is still fresh — what it was, how much, who paid and how it splits — in under a minute on a phone, without asking anyone first.
- See, at a glance, what I owe and what I am owed in total and per person, without doing arithmetic or asking anyone.
- Settle up in the fewest transfers the group can manage, record the payment, and have both sides' balances move at once.
- Add someone who is not here yet — by link, or by name before they have an account — so the trip can be recorded before everyone signs up.
- Trust the number: know that a split is exact, that it has not changed since the expense was entered, and that who can see it is deliberate.
- Find one expense from three months ago without scrolling, by who was involved, what it was categorised as, or what it was called.

## In scope

- Phase 1 — the application skeleton on Vercel's shape, the database layer (PGlite locally, Postgres in production) with migrations, accounts and sessions, and the health endpoint.
- Phase 2 — groups: create, invite links, placeholder members and claiming, roles, leave and remove.
- Phase 3 — expenses with multiple payers, all four split types, categories, edit and delete.
- Phase 4 — balances, simplified debts and settle-up with partial payments; balances across groups on the home screen.
- Phase 5 — the activity feed, search and filters, the seed, and the README's deploy guide.

## Deliberately not doing

- Password reset and account deletion. Both need an outbound email channel, which is a delivery dependency, a domain reputation problem and a new failure mode — a much larger surface than the feature it serves, and the group can work around a forgotten password for the length of a trip. Session revocation and signing out are real and are built.
- Paying through the app, whether by UPI or card. The app records a payment; it does not move money. Taking payment means a merchant account, PCI scope, webhook reconciliation and a second, much more dangerous authorisation model, none of which the product needs to be useful.
- Receipt photos and scanning. Storage, image resizing, an upload surface and OCR are a project of their own. The description field carries the information the product actually needs.
- Recurring expenses. A monthly rent that has to be re-entered every month is friction, but recurrence interacts with editing, deleting and the activity feed in ways that are cheap to add later and expensive to get right before the data model exists.
- Multiple currencies inside one group, and exchange rates. A group with one currency is what a group has; a conversion table is a rate source, a rounding policy for converted values and an audit question, and it undermines the one property the product is selling, that a balance is exact.
- Charts and spending reports. The question a user actually asks is 'who owes whom', which is a number, not a picture. Charts also imply history and categories at a depth the feed does not yet have.
- Native mobile apps. The product is mobile-first and responsive; a web app that works on a phone reaches the user sooner and costs nothing to distribute, and it is the reason the whole thing is one Next.js application.
- Email notifications. Nothing in the product is time-critical enough to interrupt someone about, and an email channel brings deliverability, unsubscribe handling and a queue.

## Success

- **A single expense is recorded, start to finish, without leaving one screen** — under 60 seconds on a 360px-wide viewport, with no horizontal scrolling and no keyboard required
  - measured by: QA times the flow on the seeded group; the form's step count is asserted in a QA run.
- **A split is exact — the parts always sum to the whole** — 0 discrepancies across 10,000 randomly generated splits, including totals of 1 minor unit split three ways
  - measured by: A property test over random totals, member counts and split types, run in CI.
- **The main screens load fast enough to feel immediate** — p75 under 1 second for home, group, expenses and balances on an ordinary connection
  - measured by: Timing recorded in the QA report against the production build booted in compose mode.
- **A person can answer 'who owes whom' without scrolling further than one screen** — the group balance screen shows every member's net balance and the full transfer list with no scrolling at 360px and none at 1280px
  - measured by: QA check on the group screen at both widths.
- **The pipeline's browser QA finds product defects, not infrastructure ones** — at least 80% of issues QA files in the first ten tickets are product defects, and none is a boot, seed or readiness failure
  - measured by: The issues QA files during the first ten tickets, classified by hand.
- **A new contributor can run it and deploy it from the README alone** — one command to run locally and a complete Vercel deploy guide, verified by following both on a clean machine
  - measured by: A human follows the README on a fresh checkout with no prior context.

## Constraints

- The spec's hard constraints are binding: TypeScript and one Next.js App Router application on Vercel, Postgres with a PGlite fallback and zero local setup, authorisation on the server for every read and write, exact money, and secrets only from environment variables.
- The SDLC pipeline in .sdlc/ is the delivery mechanism: it installs with --ignore-scripts, runs `npm run sdlc:verify` before any agent sees a diff, boots the app with `npm run sdlc:serve` for QA in compose mode on port 3000, and seeds it with `npm run sdlc:seed` through localhost only. Anything that breaks one of those breaks every ticket.
- The agents downstream read only this brief and a diff. A decision not written here will be re-made per ticket, differently each time, by agents that cannot see one another.
