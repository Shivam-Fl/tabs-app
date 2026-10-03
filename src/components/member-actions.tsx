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

  // Through a ref so the continuation calls the latest onSuccess without the wrapped action
  // having to be rebuilt (or the callback re-run) whenever the caller passes a new closure.
  const onSuccessRef = useRef(onSuccess);
  useEffect(() => {
    onSuccessRef.current = onSuccess;
  });

  /**
   * The success callback runs in the AWAITED CONTINUATION of the action, not in an effect on the
   * action state, and the difference is the whole bug. Leaving revalidates the members page, and
   * the caller is no longer a member, so that page resolves to notFound and unmounts this
   * control in the SAME commit that delivers the result — the state update and any effect on it
   * go with the unmount, and the navigation never happens. A pending promise is not part of the
   * tree: nothing unmounts it, so the continuation still runs and the "You left Lisbon · Undo"
   * notice is reachable, which is the only affordance for an undoable action.
   *
   * It is the bug class src/components/join-screen.tsx documents, and it cannot be fixed the way
   * that screen fixes it: TR-1 requires a non-member to get the not-found page rather than a
   * list confirming the group exists, so the navigation must not depend on staying mounted.
   */
  const wrapped = async (previous: MemberResult | null, formData: FormData) => {
    const result = await action(previous, formData);
    if (result.ok) onSuccessRef.current(result.groupId);
    return result;
  };

  const [state, formAction, pending] = useActionState<MemberResult | null, FormData>(wrapped, null);

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
  const router = useRouter();
  const { formRef, open, setOpen, state, formAction, pending } = useMemberAction(removeMember, () => {
    // No navigation: the removal happened on this screen, so this screen is where it shows — the
    // confirmation below lands the moment the action resolves, and the refresh drops the row
    // from the server-rendered list underneath it.
    router.refresh();
  });
  const removed = Boolean(state?.ok);

  return (
    <>
      {/*
        busyLabel only while the action is in flight: Button renders it in place of the children
        for the whole time it is disabled, so leaving it on after a successful removal would read
        'Removing…' for good over a button that has finished.
      */}
      <Button
        variant="secondary"
        onClick={() => setOpen(true)}
        disabled={pending || removed}
        busyLabel={pending ? 'Removing…' : undefined}
      >
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
      {/* The in-place confirmation docs/ui.md asks for after a removal the person cannot see
          happen otherwise. It is announced as it is inserted; the row leaving the refreshed list
          is what stays true if the announcement is missed. */}
      {removed ? (
        <p role="status" className="text-sm text-positive">
          Removed {memberName}.
        </p>
      ) : null}
      {state?.formError ? (
        <p role="alert" className="text-sm text-negative">
          {state.formError}
        </p>
      ) : null}
    </>
  );
}
