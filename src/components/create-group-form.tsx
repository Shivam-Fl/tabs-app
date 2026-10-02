'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import { createGroup } from '@/app/actions/groups';
import type { GroupResult } from '@/app/actions/groups';
import { Button, Field } from '@/components/ui';

/**
 * The create-group form. A Client Component for the same two reasons as auth-form.tsx: the
 * pending state on the submit button, and the navigation to the group the action just created —
 * which is the client's job rather than the action's, because a redirect() thrown inside the
 * action's transaction would roll it back to zero rows.
 *
 * It imports nothing from src/db or src/lib, as conventions.md requires of a Client Component.
 */
const TYPE_OPTIONS = [
  { value: 'trip', label: 'Trip' },
  { value: 'home', label: 'Home' },
  { value: 'couple', label: 'Couple' },
  { value: 'other', label: 'Other' },
] as const;

export function CreateGroupForm({ defaultCurrency }: { defaultCurrency: string }) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<GroupResult | null, FormData>(createGroup, null);

  const formRef = useRef<HTMLFormElement>(null);
  const [name, setName] = useState('');
  // Seeded from the caller's own default, which is the currency most of their groups are in.
  // They can change it here; the group keeps whatever it was created with.
  const [currency, setCurrency] = useState(defaultCurrency);
  const [type, setType] = useState<string>('other');

  useEffect(() => {
    if (state?.ok && state.groupId) router.push(`/groups/${state.groupId}`);
  }, [state, router]);

  // docs/ui.md: focus moves to the first invalid field, never a toast.
  useEffect(() => {
    if (!state) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [state]);

  return (
    <form ref={formRef} action={formAction} className="flex max-w-[360px] flex-col gap-space-3" noValidate>
      <Field
        name="name"
        label="Group name"
        autoComplete="off"
        required
        value={name}
        onChange={setName}
        error={state?.fieldErrors?.name}
      />
      <Field
        name="currency"
        label="Currency"
        autoComplete="off"
        required
        value={currency}
        onChange={setCurrency}
        error={state?.fieldErrors?.currency}
      />

      {/* There is no Select primitive in src/components/ui yet. One four-option control is not
          the second case that justifies adding one, so this is a labelled native select in the
          Input primitive's own classes rather than a new primitive. The server validates the
          value against the enum in src/db/schema.ts regardless of what this renders. */}
      <div className="flex flex-col gap-space-1">
        <label htmlFor="field-type" className="text-sm text-text">
          Type
        </label>
        <select
          id="field-type"
          name="type"
          value={type}
          onChange={(event) => setType(event.target.value)}
          className="min-h-[44px] rounded-radius border border-border bg-bg px-space-3 text-base text-text"
        >
          {TYPE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      {state?.formError ? (
        <p role="alert" className="text-sm text-negative">
          {state.formError}
        </p>
      ) : null}

      <Button type="submit" disabled={pending} busyLabel="Creating…">
        Create group
      </Button>
    </form>
  );
}
