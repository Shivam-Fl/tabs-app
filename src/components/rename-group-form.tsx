'use client';

import { useActionState, useEffect, useRef, useState } from 'react';

import { renameGroup } from '@/app/actions/groups';
import type { GroupResult } from '@/app/actions/groups';
import { Button, Field } from '@/components/ui';

/**
 * The owner's rename form. Rendered only for the owner — the members screen decides that — and
 * refused by the action as well, because a control that is merely absent is not a permission.
 */
export function RenameGroupForm({ groupId, name: initialName }: { groupId: string; name: string }) {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction, pending] = useActionState<GroupResult | null, FormData>(renameGroup, null);
  const [name, setName] = useState(initialName);

  // The field follows the group when it is renamed elsewhere, so the form never shows a stale
  // name as if it were the current one.
  useEffect(() => {
    setName(initialName);
  }, [initialName]);

  useEffect(() => {
    if (!state) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [state]);

  return (
    <form ref={formRef} action={formAction} className="flex max-w-[360px] flex-col gap-space-2" noValidate>
      <input type="hidden" name="groupId" value={groupId} />
      <Field
        name="name"
        label="Group name"
        autoComplete="off"
        required
        value={name}
        onChange={setName}
        error={state?.fieldErrors?.name}
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

      <Button type="submit" variant="secondary" disabled={pending} busyLabel="Saving…">
        Save
      </Button>
    </form>
  );
}
