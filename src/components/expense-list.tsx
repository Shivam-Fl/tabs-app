import Link from 'next/link';

import type { ExpenseRow, GroupRow } from '@/lib/access';
import { formatMinor } from '@/lib/money';
import { EmptyState, LinkButton } from '@/components/ui';

/**
 * The expenses list's body. Presentational and synchronous, like GroupOverview and
 * MembersScreen, so a component test can render it with and without rows and assert the empty
 * state's exact words and the order it was given.
 *
 * The order is the query's: newest first by the date the expense happened on, with created_at
 * then id breaking a tie (AC-13). Nothing here sorts, because a second sort in the render is a
 * second answer to the same question.
 *
 * Amounts are a plain mono span rather than the Money primitive: an expense's amount has no
 * direction — it is neither owed nor owing, it is what was spent — and the primitive's whole
 * contract is the direction words beside the figure (AC-12).
 *
 * Every row is a WHOLE-ROW link to that expense's edit screen (docs/ui.md, Lists), so the row is
 * the target rather than a word inside it: a 44px-tall touch target, and no second control
 * competing with the amount for the right-hand edge.
 */
export function ExpenseList({
  group,
  expenses,
  deletedDescription = null,
}: {
  group: GroupRow;
  expenses: ExpenseRow[];
  /**
   * The description of an expense that was just deleted, resolved on the server from the id in
   * the URL — or null, which is what a forged or stale id gets. The page reads it; this component
   * only renders the sentence, so nothing in the URL can reach the screen as words.
   */
  deletedDescription?: string | null;
}) {
  const addHref = `/groups/${group.id}/expenses/new`;

  return (
    <div className="flex flex-col gap-space-6">
      <header className="flex flex-col gap-space-1">
        <Link href={`/groups/${group.id}`} className="inline-flex min-h-[44px] items-center text-base text-text-muted">
          ← {group.name}
        </Link>
        <h1>Expenses</h1>
        <p className="text-sm text-text-muted">{group.name}</p>
      </header>

      {/* The in-place confirmation docs/ui.md asks for: no toast, this screen says what changed.
          One string rather than three children, so what is read is exactly the sentence the
          server resolved and nothing a template could have contributed. */}
      {deletedDescription ? (
        <p
          role="status"
          className="flex min-h-[44px] items-center rounded-radius border border-border bg-surface px-space-3 py-space-2 text-base"
        >
          {`Deleted ${deletedDescription}.`}
        </p>
      ) : null}

      {expenses.length === 0 ? (
        // docs/ui.md's empty-state pattern, word for word: the sentence that says what to do
        // and the single action that does it.
        <EmptyState
          title="No expenses yet"
          description="Add the first expense for this group."
          action={
            <LinkButton href={addHref} size="lg">
              Add expense
            </LinkButton>
          }
        />
      ) : (
        <ul className="flex flex-col">
          {expenses.map((expense) => (
            <li key={expense.id} className="border-b border-border last:border-b-0">
              {/* The whole row is the link, and it is what carries the row's layout: the divider
                  belongs to the list item, everything a person can see and touch belongs to the
                  anchor. */}
              <Link
                href={`/groups/${group.id}/expenses/${expense.id}/edit`}
                // The amount stays on one line: a column of money that wraps is a column that
                // cannot be scanned (docs/ui.md, Expenses · Narrow).
                className="flex min-h-[44px] items-start justify-between gap-space-3 py-space-3"
              >
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{expense.description}</span>
                  <span className="text-sm text-text-muted">{describePayers(expense)}</span>
                  {expense.category ? (
                    <span className="mt-space-1 w-fit rounded-radius border border-border bg-surface px-space-2 text-sm text-text-muted">
                      {expense.category}
                    </span>
                  ) : null}
                </span>
                <span className="flex shrink-0 flex-col items-end">
                  <span className="font-mono tabular-nums">
                    {formatMinor(expense.amountMinor, expense.currency)}
                  </span>
                  <span className="text-sm text-text-muted">{expense.date}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {expenses.length > 0 ? (
        <nav aria-label="Expenses">
          <LinkButton href={addHref} size="lg">
            Add expense
          </LinkButton>
        </nav>
      ) : null}
    </div>
  );
}

/**
 * Who paid, and — when it took more than one — how much each of them put in. One payer reads as
 * a sentence; several read as a list, because "Sam and Priya" leaves the split of the total
 * unstated on the one row where it matters.
 */
function describePayers(expense: ExpenseRow): string {
  if (expense.payers.length === 0) return 'Nobody recorded as paying';
  if (expense.payers.length === 1) return `Paid by ${expense.payers[0]?.displayName ?? 'a member'}`;

  const parts = expense.payers
    .map((payer) => `${payer.displayName} ${formatMinor(payer.amountMinor, expense.currency)}`)
    .join(', ');
  return `Paid by ${parts}`;
}
