'use client';

import { useActionState, useEffect, useRef, useState } from 'react';

import { addPlaceholderMember, claimPlaceholder } from '@/app/actions/members';
import type { MemberResult } from '@/app/actions/members';
import { Button, Field } from '@/components/ui';

/**
 * Adding somebody by name before they have an account, and claiming that entry once you have
 * one. Both are 'use client' for the same reason as every other action control here: the busy
 * state, and a refusal that has to reach the screen as a sentence.
 *
 * Which of these a viewer gets is decided by MembersScreen from their membership; whether the
 * write is allowed is decided by the action, against the database.
 */

export function AddPlaceholderForm({ groupId }: { groupId: string }) {
  const [state, formAction, pending] = useActionState<MemberResult | null, FormData>(addPlaceholderMember, null);
  const [name, setName] = useState('');

  // Cleared on success and left alone on failure: a duplicate name is allowed, so an owner
  // adding two people in a row should not have to fight the form, and an owner whose first
  // attempt was refused must not lose what they typed.
  useEffect(() => {
    if (state?.ok) setName('');
  }, [state]);

  return (
    <form action={formAction} className="flex flex-col gap-space-2 sm:max-w-[360px]">
      <input type="hidden" name="groupId" value={groupId} />
      <Field
        name="name"
        label="Name"
        value={name}
        onChange={setName}
        error={state?.fieldErrors?.name}
        hint="They can claim this entry when they create an account."
      />
      {state?.formError ? (
        <p role="alert" className="text-sm text-negative">
          {state.formError}
        </p>
      ) : null}
      <Button type="submit" variant="secondary" disabled={pending} busyLabel="Adding…">
        Add member
      </Button>
    </form>
  );
}

/**
 * Claims a placeholder as its owner. There is no confirmation dialog, because nothing is being
 * destroyed: this ends the caller's own duplicate row and attaches their account to the entry
 * that already carries their name.
 */
export function ClaimButton({
  groupId,
  memberId,
  memberName,
}: {
  groupId: string;
  memberId: string;
  memberName: string;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction, pending] = useActionState<MemberResult | null, FormData>(claimPlaceholder, null);

  return (
    <>
      <Button
        variant="secondary"
        disabled={pending}
        busyLabel="Claiming…"
        aria-label={`Claim ${memberName}`}
        onClick={() => formRef.current?.requestSubmit()}
      >
        Claim
      </Button>
      <form ref={formRef} action={formAction} className="hidden">
        <input type="hidden" name="groupId" value={groupId} />
        <input type="hidden" name="memberId" value={memberId} />
      </form>
      {state?.formError ? (
        <p role="alert" className="text-sm text-negative">
          {state.formError}
        </p>
      ) : null}
    </>
  );
}
