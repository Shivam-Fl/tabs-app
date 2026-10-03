import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';

import { database } from '@/db/client';
import { readExpenseForEdit, readGroup } from '@/lib/access';
import { requireUser } from '@/lib/auth';
import { formatMajorUnits, formatSplitInput } from '@/lib/money';
import { DeleteExpenseButton } from '@/components/delete-expense-button';
import { ExpenseForm } from '@/components/expense-form';
import { LinkButton } from '@/components/ui';

export const metadata: Metadata = { title: 'Edit expense · Tabs' };

/**
 * The edit screen.
 *
 * The stored expense is rendered back to TEXT here rather than handed to the form as bigints:
 * every number goes through src/lib/money.ts's inverse formatters, which emit exactly what the
 * matching input's parser accepts — no symbol, no grouping separator, the currency's own decimal
 * places. That round trip is the whole of AC-6: reopening an expense and saving it untouched
 * produces the same rows, because the text a person sees is text the server would parse to the
 * same minor units.
 *
 * The member list comes from readExpenseForEdit and is passed through unchanged, order included:
 * it is the canonical order extended to members who have since left, which is the order the
 * split's remainder rule is defined against. Re-sorting it here would be a second answer to that
 * question, and the wrong one for an expense whose first participant has left (AC-3).
 *
 * A missing or deleted expense is a state on this screen, not a 404: the group is readable — the
 * caller is in it — and saying so is what keeps a deleted row from being reopened by a back
 * button. Only the group itself being unreadable is notFound, because that is the same answer a
 * non-member gets everywhere else (TR-1).
 */
const paramsSchema = z.object({ id: z.string().uuid(), expenseId: z.string().uuid() });

export default async function EditExpensePage({
  params,
}: {
  params: Promise<{ id: string; expenseId: string }>;
}) {
  const user = await requireUser();
  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) notFound();

  const { id, expenseId } = parsed.data;
  const db = await database();
  const group = await readGroup(db, id, user.id);
  if (!group) notFound();

  const expense = await readExpenseForEdit(db, id, expenseId, user.id);
  const backHref = `/groups/${group.id}/expenses`;

  if (!expense) {
    return (
      <div className="flex max-w-[420px] flex-col gap-space-6">
        <header className="flex flex-col gap-space-1">
          <Link href={backHref} className="inline-flex min-h-[44px] items-center text-base text-text-muted">
            ← Expenses
          </Link>
          <h1>Expense unavailable</h1>
          <p className="text-sm text-text-muted">{group.name}</p>
        </header>
        <p className="text-base text-text-muted">
          This expense is no longer available. It may have been deleted.
        </p>
        <LinkButton href={backHref} variant="secondary" size="lg">
          Back to expenses
        </LinkButton>
      </div>
    );
  }

  // The stored rule, in the units its split type counts in: minor units for an exact split,
  // hundredths of a percent for a percentage one, a plain count for shares.
  const inputs: Record<string, string> = {};
  for (const participant of expense.participants) {
    inputs[participant.memberId] = formatSplitInput(
      expense.splitType,
      participant.inputValue,
      expense.currency,
    );
  }

  const payerAmounts: Record<string, string> = {};
  for (const payer of expense.payers) {
    payerAmounts[payer.memberId] = formatMajorUnits(payer.amountMinor, expense.currency);
  }

  // The server's own date, in UTC, exactly as the new-expense screen reads it: it is not used
  // while editing — the stored date wins — but the prop is not optional, and a form that read
  // the clock on only one of its two routes is a form whose two routes can disagree.
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="flex flex-col gap-space-6">
      <header className="flex flex-col gap-space-1">
        <Link href={backHref} className="inline-flex min-h-[44px] items-center text-base text-text-muted">
          ← Expenses
        </Link>
        <h1>Edit expense</h1>
        <p className="text-sm text-text-muted">{group.name}</p>
      </header>

      <ExpenseForm
        group={{ id: group.id, name: group.name, currency: group.currency }}
        members={expense.members}
        today={today}
        initial={{
          expenseId: expense.id,
          description: expense.description,
          amount: formatMajorUnits(expense.amountMinor, expense.currency),
          date: expense.date,
          category: expense.category ?? '',
          note: expense.note ?? '',
          splitType: expense.splitType,
          participants: expense.participants.map((participant) => participant.memberId),
          inputs,
          payers: expense.payers.map((payer) => payer.memberId),
          payerAmounts,
        }}
      />

      <div className="max-w-[420px]">
        <DeleteExpenseButton
          groupId={group.id}
          expenseId={expense.id}
          description={expense.description}
        />
      </div>
    </div>
  );
}
