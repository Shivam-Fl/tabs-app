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
  /**
   * Optional, and only for a caller that NAVIGATES on success. Leaving does, and it has to run
   * from the continuation rather than from an effect on the state — see the note below. A caller
   * that stays on the screen leaves this out and reacts to the committed state instead, which is
   * what orders its confirmation before the refresh it dispatches.
   */
  onSuccess?: (groupId: string | undefined) => void,
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
    if (result.ok) onSuccessRef.current?.(result.groupId);
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
  // No success callback: a removal happens on this screen, so this screen is where it shows and
  // nothing here navigates. The refresh is dispatched from the committed state below.
  const { formRef, open, setOpen, state, formAction, pending } = useMemberAction(removeMember);
  const announced = useRef(false);
  // Derived from the committed state, NOT held separately and set from the effect below. This is
  // what puts the confirmation in the DOM strictly before the refresh is dispatched: it renders
  // in the very commit that delivers the ok state, and the effect that refreshes runs after that
  // commit — so there is no render between them in which the status could be missing.
  const removed = Boolean(state?.ok);

  /**
   * The refresh is dispatched from an effect on the committed state rather than from inside the
   * wrapped action, so it cannot fire before the ok state has rendered: the confirmation is in
   * the document by the time this runs, and `router.refresh()` is an asynchronous round trip that
   * cannot resolve before it. It mirrors ArchiveButton — the same once-guarded effect.
   *
   * Ordering is only half of it, and the other half is upstream of this file: nothing here is
   * readable if `removeMember` revalidates as well. Measured on a production build, with the
   * action's `revalidatePath('/', 'layout')` still in place, the re-rendered members page — the
   * removed row already gone, this control unmounted with it — ships back in the SAME commit as
   * the ok state, and the status never becomes a node however this effect is written. That is
   * why `removeMember` is the one action that does not revalidate, and why this screen's own
   * refresh is what re-renders the list.
   */
  useEffect(() => {
    // Once: the result object is what this reacts to, and it stays the same across renders.
    if (!state?.ok || announced.current) return;
    announced.current = true;
    // Belt and braces: the action's own revalidation has usually already refreshed the list, but
    // refetching the route here costs one request and leaves the screen correct even if it has
    // not. The confirmation stays committed until the row goes with it either way.
    router.refresh();
  }, [state, router]);

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
