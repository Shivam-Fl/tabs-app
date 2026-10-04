'use client';

import { useActionState, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import { deletePayment } from '@/app/actions/payments';
import type { PaymentResult } from '@/app/actions/payments';
import { Button, Dialog } from '@/components/ui';

/**
 * Deleting a payment, behind the design system's confirmation dialog.
 *
 * Only the two members a payment involves may delete it (TR-7), so the control is rendered only
 * on their rows — the balances screen decides that, because the same figure decides it on the
 * server — and the dialog is what remains: it names the payment being destroyed rather than asking
 * "are you sure". The confirm is a submit of a real form, so the write is the same Server Action
 * call the no-JS path makes.
 *
 * The refresh is the awaited continuation rather than an effect on the action state, for the
 * reason DeleteExpenseButton gives: the continuation is a pending promise and runs even if this
 * subtree unmounts when the revalidated balances arrive.
 */
export function DeletePaymentButton({
  groupId,
  paymentId,
  description,
}: {
  groupId: string;
  paymentId: string;
  /** The payment in one line — "€4.00 from Sam to Priya" — as the row renders it. */
  description: string;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [open, setOpen] = useState(false);

  const wrapped = async (previous: PaymentResult | null, formData: FormData) => {
    const result = await deletePayment(previous, formData);
    if (result.ok) router.refresh();
    return result;
  };

  const [state, formAction, pending] = useActionState<PaymentResult | null, FormData>(wrapped, null);

  return (
    <>
      <Button
        variant="destructive"
        onClick={() => setOpen(true)}
        disabled={pending}
        busyLabel="Deleting…"
        // The visible label is the same on every row, so the accessible name is the payment
        // itself: a screen reader hears "Delete €4.00 from Sam to Priya" rather than three
        // buttons all called "Delete payment".
        aria-label={`Delete ${description}`}
      >
        Delete payment
      </Button>
      <Dialog
        open={open}
        title={`Delete ${description}?`}
        consequence="This puts both balances back the way they were before it. This cannot be undone."
        confirmLabel={`Delete ${description}`}
        onConfirm={() => {
          setOpen(false);
          formRef.current?.requestSubmit();
        }}
        onCancel={() => setOpen(false)}
      />
      <form ref={formRef} action={formAction} className="hidden">
        <input type="hidden" name="groupId" value={groupId} />
        <input type="hidden" name="paymentId" value={paymentId} />
      </form>
      {state?.formError ? (
        <p role="alert" className="mt-space-2 text-sm text-negative">
          {state.formError}
        </p>
      ) : null}
    </>
  );
}
