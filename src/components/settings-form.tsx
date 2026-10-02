'use client';

import { useActionState, useEffect, useRef, useState } from 'react';

import { updateProfile } from '@/app/actions/profile';
import type { ProfileResult } from '@/app/actions/profile';
import { Button, Field } from '@/components/ui';

/**
 * The profile form: display name and default currency, one Save button.
 *
 * A Client Component for the same reason as auth-form.tsx — the pending state on Save — and
 * controlled for the same reason: an expected failure keeps every value the person typed.
 */
export function SettingsForm({
  displayName: initialName,
  defaultCurrency: initialCurrency,
}: {
  displayName: string;
  defaultCurrency: string;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction, pending] = useActionState<ProfileResult | null, FormData>(updateProfile, null);

  const [displayName, setDisplayName] = useState(initialName);
  const [defaultCurrency, setDefaultCurrency] = useState(initialCurrency);

  // docs/ui.md: focus moves to the first invalid field, never a toast and never a summary.
  useEffect(() => {
    if (!state) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [state]);

  return (
    <form ref={formRef} action={formAction} className="flex max-w-[360px] flex-col gap-space-3" noValidate>
      <Field
        name="displayName"
        label="Your name"
        autoComplete="name"
        required
        value={displayName}
        onChange={setDisplayName}
        error={state?.fieldErrors?.displayName}
      />
      <Field
        name="defaultCurrency"
        label="Default currency"
        required
        value={defaultCurrency}
        onChange={setDefaultCurrency}
        error={state?.fieldErrors?.defaultCurrency}
      />

      {state?.formError ? (
        <p role="alert" className="text-sm text-negative">
          {state.formError}
        </p>
      ) : null}
      {state?.ok ? (
        <p role="status" className="text-sm text-positive">
          Saved.
        </p>
      ) : null}

      <Button type="submit" disabled={pending} busyLabel="Saving…">
        Save
      </Button>
    </form>
  );
}