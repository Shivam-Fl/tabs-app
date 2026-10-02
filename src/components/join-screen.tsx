'use client';

import { useActionState, useEffect } from 'react';
import { useRouter } from 'next/navigation';

import { joinWithToken } from '@/app/actions/members';
import type { MemberResult } from '@/app/actions/members';
import { Button, LinkButton } from '@/components/ui';

/**
 * What the invite link opens: the question, the confirm button, and the answer once there is
 * nothing left to ask.
 *
 * ONE component rather than two server branches, and that is load-bearing. The confirm's action
 * revalidates the route, so the server re-renders this page the moment the join succeeds — as
 * the already-a-member state. Were the notice a separate branch of the page, that re-render
 * would replace this component and unmount it in the same commit that delivers the result,
 * taking the navigation with it (the effect below would never run, and confirming would leave
 * the person sitting on the invite instead of in their group). Rendering both states from one
 * component means the refresh reconciles it in place, so the result survives to be acted on.
 *
 * It is a Client Component for the same two reasons auth-form.tsx is: the in-flight state
 * ("Joining…") is only observable through useActionState, and the navigation is the client's job
 * rather than the action's — a redirect() thrown inside the action's transaction would roll it
 * back to zero rows, as src/app/actions/groups.ts spells out.
 *
 * The refusal is not hypothetical: the page was rendered from a token that was live at the time,
 * and the owner can rotate or disable the link between that render and this submission, in which
 * case the action answers with a sentence here rather than throwing. The token travels in the
 * form body rather than in the action's arguments, so the no-JS path submits exactly the same
 * thing.
 */
export function JoinScreen({
  token,
  groupId,
  groupName,
  isMember,
}: {
  token: string;
  groupId: string;
  groupName: string;
  /** Whether the server already knows this caller is in — the link was used on an earlier visit. */
  isMember: boolean;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<MemberResult | null, FormData>(joinWithToken, null);

  // The group the client is about to open: the one the action just returned, or the one the
  // server rendered this screen for.
  const target = state?.groupId ?? groupId;
  const joined = isMember || state?.ok === true;

  useEffect(() => {
    if (state?.ok && state.groupId) router.push(`/groups/${state.groupId}`);
  }, [state, router]);

  if (joined) {
    return (
      <>
        <h1 className="text-2xl">You&apos;re already in {groupName}</h1>
        <p className="mt-space-3 text-base text-text-muted">
          This invite link has already been used, so there is nothing left to confirm.
        </p>
        <LinkButton href={`/groups/${target}`} className="mt-space-4 w-full sm:w-auto">
          Open {groupName}
        </LinkButton>
      </>
    );
  }

  return (
    <>
      <h1 className="text-2xl">Join {groupName}?</h1>
      <p className="mt-space-3 text-base text-text-muted">
        {groupName} will appear on your home screen, and its members will see your name alongside
        theirs.
      </p>
      <form action={formAction} className="mt-space-4 flex flex-col gap-space-3">
        <input type="hidden" name="token" value={token} />
        {state?.formError ? (
          <p role="alert" className="text-sm text-negative">
            {state.formError}
          </p>
        ) : null}
        <Button type="submit" size="lg" disabled={pending} busyLabel="Joining…">
          Join {groupName}
        </Button>
      </form>
    </>
  );
}
