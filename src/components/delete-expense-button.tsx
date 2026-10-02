'use client';

import { useActionState, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import { deleteExpense } from '@/app/actions/expenses';
import type { ExpenseResult } from '@/app/actions/expenses';
import { Button, Dialog } from '@/components/ui';

/**
 * Deleting an expense, behind the design system's confirmation dialog.
 *
 * Any member may delete, so unlike Leave and Remove this control is not owner-scoped — the dialog
 * is the whole of the gate, and it names the expense being destroyed rather than asking "are you
 * sure". The confirm is a submit of a real form, so the write is the same Server Action call the
 * no-JS path makes.
 *
 * The navigation is the leave button's, for the same reason: the delete revalidates the edit
 * screen, which no longer resolves once the expense is gone, so this screen and this button
 * unmount in the SAME commit that delivers the result. An effect on the action state would go
 * with the unmount and never navigate; the awaited continuation is a pending promise, which is
 * not part of the tree and still runs.
 *
 * The destination carries the expense's ID and nothing else. The sentence the list confirms with
 * is resolved on the server from that id, so a URL somebody typed cannot put words on the screen.
 */
export function DeleteExpenseButton({
  groupId,
  expenseId,
  description,
}: {
  groupId: string;
  expenseId: string;
  description: string;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [open, setOpen] = useState(false);

  const wrapped = async (previous: ExpenseResult | null, formData: FormData) => {
    const result = await deleteExpense(previous, formData);
    if (result.ok) {
      router.push(`/groups/${result.groupId ?? groupId}/expenses?deleted=${expenseId}`);
    }
    return result;
  };

  const [state, formAction, pending] = useActionState<ExpenseResult | null, FormData>(wrapped, null);

  return (
    <>
      <Button variant="destructive" onClick={() => setOpen(true)} disabled={pending} busyLabel="Deleting…">
        Delete expense
      </Button>
      <Dialog
        open={open}
        title={`Delete ${description}?`}
        consequence="This removes it from the group's balances. This cannot be undone."
        confirmLabel={`Delete ${description}`}
        onConfirm={() => {
          setOpen(false);
          formRef.current?.requestSubmit();
        }}
        onCancel={() => setOpen(false)}
      />
      <form ref={formRef} action={formAction} className="hidden">
        <input type="hidden" name="groupId" value={groupId} />
        <input type="hidden" name="expenseId" value={expenseId} />
      </form>
      {state?.formError ? (
        <p role="alert" className="mt-space-2 text-sm text-negative">
          {state.formError}
        </p>
      ) : null}
    </>
  );
}
