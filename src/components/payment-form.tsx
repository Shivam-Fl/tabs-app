'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import { recordPayment } from '@/app/actions/payments';
import type { PaymentResult } from '@/app/actions/payments';
import { currencySymbol } from '@/lib/money';
import { Button, Field } from '@/components/ui';

/**
 * The Record payment form: who paid whom, how much, and an optional note.
 *
 * A Client Component for the reasons conventions.md gives: the refusal has to come back as
 * field-level errors with every value still typed in, the busy state is only observable through
 * useActionState, and the balances behind the form move without a page reload — which is a
 * router.refresh() on success rather than a navigation, because the person is recording a series
 * of settlements on one screen and being sent somewhere else after each would be the opposite of
 * one pass.
 *
 * It imports the action and money.ts and never src/db or src/lib/auth, like every other form here.
 */
export interface PaymentFormMember {
  memberId: string;
  displayName: string;
}

export function PaymentForm({
  group,
  members,
  defaultFrom = '',
  defaultTo = '',
}: {
  group: { id: string; currency: string };
  /** Every active member, in canonical order: the two selects offer exactly these. */
  members: PaymentFormMember[];
  /**
   * What the two selects open on. The balances page supplies the first simplified transfer's
   * debtor and creditor when the group has a debt to settle — which is the payment somebody is
   * about to make — and the first two members otherwise, so the ordinary case needs no choosing.
   */
  defaultFrom?: string;
  defaultTo?: string;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction, pending] = useActionState<PaymentResult | null, FormData>(recordPayment, null);

  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');

  /**
   * What a recording does to the form: clear the two things that describe THIS payment and leave
   * the two that describe the next one.
   *
   * The people stay chosen — a group settling up records the same pair a second time often — but
   * the amount and the note go, because a form still holding "4.00" after it has been recorded
   * invites a second click that pays twice. The refresh is what moves the balances behind the
   * form without navigating.
   */
  useEffect(() => {
    if (!state?.ok) return;
    setAmount('');
    setNote('');
    router.refresh();
  }, [state, router]);

  /**
   * Puts back what React's post-action form reset drops.
   *
   * Once an action has run React resets the form, and as it re-renders it restores a controlled
   * text field's value but NOT a `<select>`'s. Without this, a refusal — amount 0, say — would
   * leave the chosen members silently back at the first option while the amount and the note
   * stayed, which is the form keeping half of what the person entered.
   */
  useEffect(() => {
    const form = formRef.current;
    if (!state || !form) return;
    for (const control of form.querySelectorAll<HTMLSelectElement>('select')) {
      if (control.name === 'from') control.value = from;
      else if (control.name === 'to') control.value = to;
    }
  }, [state, from, to]);

  // docs/ui.md: focus moves to the first invalid field, never a toast. The server decides what is
  // invalid and the refusal renders with the aria-invalid that says where to land.
  useEffect(() => {
    if (!state) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [state]);

  const symbol = currencySymbol(group.currency);

  return (
    <form ref={formRef} action={formAction} className="flex max-w-[420px] flex-col gap-space-4" noValidate>
      <input type="hidden" name="groupId" value={group.id} />

      <MemberSelect
        name="from"
        label="From"
        emptyLabel="Choose who paid"
        members={members}
        value={from}
        onChange={setFrom}
        error={state?.fieldErrors?.from}
      />

      <MemberSelect
        name="to"
        label="To"
        emptyLabel="Choose who was paid"
        members={members}
        value={to}
        onChange={setTo}
        error={state?.fieldErrors?.to}
      />

      {/* The currency's symbol, fixed and not editable: the group's currency was decided when the
          group was made, and an amount typed against the wrong symbol is a wrong amount. */}
      <div className="flex items-end gap-space-2">
        <span aria-hidden="true" className="flex min-h-[44px] items-center text-base text-text-muted">
          {symbol}
        </span>
        <div className="flex-1">
          <Field
            name="amount"
            label="Amount"
            inputMode="decimal"
            autoComplete="off"
            required
            value={amount}
            onChange={setAmount}
            error={state?.fieldErrors?.amount}
          />
        </div>
      </div>

      <div className="flex flex-col gap-space-1">
        <label htmlFor="field-payment-note" className="text-sm text-text">
          Note
        </label>
        <textarea
          id="field-payment-note"
          name="note"
          rows={2}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          aria-invalid={state?.fieldErrors?.note ? true : undefined}
          aria-describedby={state?.fieldErrors?.note ? 'field-payment-note-error' : undefined}
          className={`rounded-radius border bg-bg p-space-3 text-base text-text ${
            state?.fieldErrors?.note ? 'border-negative' : 'border-border'
          }`}
        />
        {state?.fieldErrors?.note ? (
          <p id="field-payment-note-error" role="alert" className="text-sm text-negative">
            {state.fieldErrors.note}
          </p>
        ) : null}
      </div>

      {state?.formError ? (
        <p role="alert" className="text-sm text-negative">
          {state.formError}
        </p>
      ) : null}

      <Button type="submit" size="lg" disabled={pending} busyLabel="Recording…">
        Record payment
      </Button>
    </form>
  );
}

/**
 * One of the two member selects.
 *
 * There is no Select primitive in src/components/ui, and two four-line selects in one file are
 * not the case that justifies adding one: this is a labelled native select in the Input
 * primitive's own classes, wired to the same aria-invalid / role="alert" error slot the Field
 * primitive renders, so a refusal beside it reads exactly as a refusal beside any other control.
 * The server validates both ids against the group's active members regardless of what this shows.
 */
function MemberSelect({
  name,
  label,
  emptyLabel,
  members,
  value,
  onChange,
  error,
}: {
  name: string;
  label: string;
  emptyLabel: string;
  members: PaymentFormMember[];
  value: string;
  onChange: (value: string) => void;
  error?: string;
}) {
  const id = `field-${name}`;
  return (
    <div className="flex flex-col gap-space-1">
      <label htmlFor={id} className="text-sm text-text">
        {label}
      </label>
      <select
        id={id}
        name={name}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        className={`min-h-[44px] rounded-radius border bg-bg px-space-3 text-base text-text ${
          error ? 'border-negative' : 'border-border'
        }`}
      >
        <option value="">{emptyLabel}</option>
        {members.map((member) => (
          <option key={member.memberId} value={member.memberId}>
            {member.displayName}
          </option>
        ))}
      </select>
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-sm text-negative">
          {error}
        </p>
      ) : null}
    </div>
  );
}
