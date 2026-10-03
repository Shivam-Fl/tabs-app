# User-typed number overflows an int8 column with a 500 instead of a field error

## Symptom

Submitting a money-like value that is *lexically* valid but physically unstorable produces a
Next.js 500 ("Couldn't load this page. Try again") instead of the per-field sentence the form
promises. The database rolls back correctly (no row), so the failure is invisible anywhere but
the browser and the user-visible behaviour of a rejected input. Found in review on the
expense path four PRs running (#25 → #28 → #29 → #32 → #34); each one re-derived the same
cause, which is why it is written down.

## Cause

`int8` is Postgres's integer type and caps at 9 223 372 036 854 775 807. Three unchecked
parsers feed three different int8 columns, so the bug reaches the insert through whichever
path nobody happened to bound:

| parser (src/lib/money.ts) | column | first found unbounded by |
| --- | --- | --- |
| `parseMajorUnits` | `expenses.amount_minor` | #25's review → #28 |
| same, on a payer part | `expense_payer.amount_minor` | #28 |
| `parseDecimal` (exact split) | `expense_split_input.input_value` | #29's review (#32's scope) |
| `parseDecimal` (a *share count*) | `expense_split_input.input_value` | #29 again (#34) |

The review's own words, which should stay in mind: "amount, payer parts, exact inputs are all
refused … percentage inputs are bounded by the sum==10000 rule, **so shares is the only
unbounded stored number**". Percentages really are safe — they must sum to exactly 10000 — so
the shape to check for is *any* user-typed number that does not have a rule constraining it,
not just "big money".

## How it was found

Not in QA. Every QA round passed 100% without submitting a floor-scale share count, because
their hostile inputs were plausible money amounts. The review, reading the parsers against
the columns, reproduced the overflow by running the insert and getting
`22003 out of range for type bigint`. The lesson is: a 500 from valid-shaped input is a
*bound* bug (a number the schema accepts, a column too narrow to store); grep the parsers and
the columns first, because only the *combination* is the bug and neither half looks at the
other.

The bound lives in src/app/actions/expenses.ts's `MAX_INT8` (`9223372036854775807n`) inside
`validateExpense`, keyed by field: an oversized *exact* amount and an oversized share count
both say "That **amount** is too large to record." (the work order for #33 held this literal
wording against main's "number"); an oversized percentage says "That **number**…" and a payer
part names the payer. The bound is `> MAX_INT8`, not `>=`: an at-maximum value is legal, and
there is a test that fails the moment someone tightens it.

## How to check quickly

`grep -n "MAX_INT8" src/app/actions/expenses.ts` — one constant, one comparison, applied to
every user-typed number that lands in an int8 column. A new input for a new column must add
its own line there before the write, not a try/catch around the insert.
