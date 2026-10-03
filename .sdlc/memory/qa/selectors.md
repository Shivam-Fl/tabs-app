# Stable selectors

Selectors that survived the first QA runs (PRs #13–#34, walked in a real Chromium against the
production build). Each names where it comes from, so it can be pruned the day that changes.
The ones worth having are the conventions — a sentence or a class name tied to one screen.

## Form errors: the id is a convention, not a coincidence

Every field error renders as `<p id="field-<name>-error" role="alert" class="text-sm text-negative">`
beside the field it belongs to, because `Field` (src/components/ui/field.tsx) derives both ids
from the field name: `const id = \`field-${name}\``, errorId `field-<name>-error`.

- Auth and settings: `#field-displayName`, `#field-email`, `#field-password`.
- Expense form: `#field-amount`, `#field-description`, `#field-date`, `#field-category`,
  `#field-note`, plus one per-member split input, whose name is literally `input.<memberId>` —
  so its id is `#field-input.<uuid>` and a CSS `#field-input.<uuid>` selector does not match
  (the dot). Use `[name="input.<memberId>"]` or `getByLabel`.
- Split-set errors do not get their own element: an "doesn't add up" refusal is rendered as the
  error of the FIRST included member's per-member field, which is also where focus goes.
- Two group-level anchors that carry their own ids rather than going through Field:
  `#payers-error` (payer parts mismatch) and `#participants-error` (empty picker).
- Assert on the id and the `role="alert"`, never on the sentence — the sentences are
  work-order text and change between tickets.

## Controls

- Split type: radio `name="splitType"`, values `equal`, `exact`, `percentage`, `shares`.
  The number beside a member is labelled per type by src/components/expense-form.tsx's
  INPUT_LABELS: "Amount for <name>", "Percent for <name>", "Shares for <name>". A member who
  is of split type `equal` gets no number at all.
- Payers: checkbox `name="payer"`, one per member. Participants: checkbox `name="participant"`.
- Focus after a refused submit lands on the first `[aria-invalid="true"]`; that is the only
  place a form-level error is findable, since a form-level message has no id (auth-form.tsx and
  expense-form.tsx both render it bare).

## Screen anchors

- The content a signed-in page sits inside is `<main id="main">` (src/components/shell.tsx);
  the skip link is `<a href="#main">` in src/app/layout.tsx. A test asserts exactly one
  `<main>` per composition — count them, don't assume.
- Amounts on an expense row are a plain `font-mono tabular-nums` span through `formatMinor`
  (`$40.00`), NOT the direction-worded `Money` primitive; balances on overview/home use
  `Money`, whose direction words ("you are owed" / "you owe" / "settled") are sr-only. An
  assertion about a balance should count on the words, not a sign.

## URL contracts after a write

- Leave → `/?left=<groupId>` — resolved server-side against the caller's own recent leave
  (readRecentLeave), so a forged or stale `?left=` renders nothing.
- Delete expense → `/groups/<groupId>/expenses?deleted=<expenseId>` — same shape
  (readDeletedExpenseDescription), an id that resolves to nothing renders no confirmation.
- Signed out, any signed-in route — `/`, `/settings`, `/groups/**` — 307s to `/sign-in`; use
  the redirect, not page copy, as the identity check.
- Every control is at least 44px on both axes (`min-h-[44px]` in the Input/Button primitives),
  including inline links inside the auth cross-link paragraph, which is `inline-flex` on
  purpose so the minimum applies to it.
