'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import { leaveGroup, removeMember } from '@/app/actions/members';
import type { MemberResult } from '@/app/actions/members';
import { Button, Dialog } from '@/components/ui';

/**
 * The two destructive membership controls: leave, and remove somebody else.
 *
 * Both confirm in the design system's Dialog, which names the group and states the consequence
 * in one sentence, traps focus and cancels on Escape. The confirm is a submit of a real form
 * rather than a call, so the write is the same Server Action call the no-JS path makes.
 */

function useMemberAction(
  action: (previous: MemberResult | null, formData: FormData) => Promise<MemberResult>,
  onSuccess: (groupId: string | undefined) => void,
) {
  const formRef = useRef<HTMLFormElement>(null);
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState<MemberResult | null, FormData>(action, null);

  // Through a ref so the effect runs on the RESULT and not on every render, which would
  // navigate once per re-render for as long as the result stays the same.
  const onSuccessRef = useRef(onSuccess);
  useEffect(() => {
    onSuccessRef.current = onSuccess;
  });
  useEffect(() => {
    if (state?.ok) onSuccessRef.current(state.groupId);
  }, [state]);

  return { formRef, open, setOpen, state, formAction, pending };
}

export function LeaveButton({ groupId, groupName }: { groupId: string; groupName: string }) {
  const router = useRouter();
  const { formRef, open, setOpen, state, formAction, pending } = useMemberAction(leaveGroup, (left) => {
    if (left) router.push(`/?left=${left}`);
  });

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)} disabled={pending} busyLabel="Leaving…">
        Leave
      </Button>
      <Dialog
        open={open}
        title={`Leave ${groupName}?`}
        consequence="You will stop seeing this group and its balances, until you undo."
        confirmLabel={`Leave ${groupName}`}
        onConfirm={() => {
          setOpen(false);
          formRef.current?.requestSubmit();
        }}
        onCancel={() => setOpen(false)}
      />
      <form ref={formRef} action={formAction} className="hidden">
        <input type="hidden" name="groupId" value={groupId} />
      </form>
      {state?.formError ? (
        <p role="alert" className="text-sm text-negative">
          {state.formError}
        </p>
      ) : null}
    </>
  );
}

export function RemoveButton({
  groupId,
  memberId,
  memberName,
}: {
  groupId: string;
  memberId: string;
  memberName: string;
}) {
  const { formRef, open, setOpen, state, formAction, pending } = useMemberAction(removeMember, () => {
    // No navigation: the removal happened on this screen, so this screen is where it shows.
  });

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)} disabled={pending} busyLabel="Removing…">
        Remove
      </Button>
      <Dialog
        open={open}
        title={`Remove ${memberName}?`}
        consequence={`${memberName} will no longer appear in this group's balances.`}
        confirmLabel={`Remove ${memberName}`}
        onConfirm={() => {
          setOpen(false);
          formRef.current?.requestSubmit();
        }}
        onCancel={() => setOpen(false)}
      />
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
