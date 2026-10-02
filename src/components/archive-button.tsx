'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import { archiveGroup } from '@/app/actions/groups';
import type { GroupResult } from '@/app/actions/groups';
import { Button } from '@/components/ui';

/**
 * The owner's archive control, owner-only twice over: the members screen renders it only for
 * the owner, and archiveGroup refuses anybody else against the database.
 *
 * It does NOT confirm, and that is deliberate rather than missing: docs/ui.md exempts archiving
 * from the destructive-confirmation rule because it is reversible and only the owner can reach
 * it. The undo is the group staying readable by its URL with its archived notice.
 */
export function ArchiveButton({ groupId, groupName }: { groupId: string; groupName: string }) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<GroupResult | null, FormData>(archiveGroup, null);
  const announced = useRef(false);
  const [archived, setArchived] = useState(false);

  useEffect(() => {
    // Once: the result object is what this reacts to, and it stays the same across renders.
    if (!state?.ok || announced.current) return;
    announced.current = true;
    setArchived(true);
    // The members screen still says "Members" for a group that has just left the home list;
    // the archived notice lives on the overview, so this refreshes the server components.
    router.refresh();
  }, [state, router]);

  return (
    <form action={formAction} className="flex flex-col items-start gap-space-2">
      <input type="hidden" name="groupId" value={groupId} />
      {/*
        busyLabel only while the action is in flight, because Button renders it in place of the
        children for the whole time it is disabled — so a busyLabel left on after the archive
        succeeded would hide 'Archived' behind 'Archiving…' for good, and the button would claim
        to be working on something it finished.
      */}
      <Button
        type="submit"
        variant="secondary"
        disabled={pending || archived}
        busyLabel={pending ? 'Archiving…' : undefined}
      >
        {archived ? 'Archived' : `Archive ${groupName}`}
      </Button>
      {state?.formError ? (
        <p role="alert" className="text-sm text-negative">
          {state.formError}
        </p>
      ) : null}
    </form>
  );
}
