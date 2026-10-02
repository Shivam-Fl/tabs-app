'use client';

import { useActionState, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import { undoLeave } from '@/app/actions/members';
import type { MemberResult } from '@/app/actions/members';

/**
 * The in-place confirmation that a leave happened, per docs/ui.md: no toast, the screen it
 * happened on says what changed and offers Undo.
 *
 * The group's NAME is a prop and is always server-resolved — the URL carries the id alone, so a
 * forged ?left= cannot put a name on the screen and a leave older than ten seconds renders
 * nothing at all. This component owns the other half: the row hides itself after ten seconds
 * rather than waiting for a reload to notice.
 *
 * The rendered sentence is "You left Lisbon · Undo" — U+00B7 at offset 16 of THAT string. The
 * template "You left <group> · Undo" has the dot at 17, because "<group>" is seven characters
 * and "Lisbon" is six; the two forms are named distinctly so no offset is carried across them.
 */
export function LeaveNotice({ groupId, groupName }: { groupId: string; groupName: string | null }) {
  const router = useRouter();
  const [state, formAction] = useActionState<MemberResult | null, FormData>(undoLeave, null);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => setVisible(false), 10_000);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (state?.ok) {
      setVisible(false);
      router.refresh();
    }
  }, [state, router]);

  // No server-resolved name means this is not the caller's own recent leave: nothing renders
  // rather than a row the URL alone could have produced.
  if (!visible || !groupName) return null;

  return (
    <div className="flex min-h-[44px] flex-wrap items-center justify-between gap-space-2 rounded-radius border border-border bg-surface px-space-3 py-space-2">
      {/* One string rather than three children, so the rendered text is exactly what the
          codepoint assertion reads: U+00B7 at 16, U+0020 at 17. */}
      <p className="text-base">{`You left ${groupName} · Undo`}</p>
      {/* A real form, so Undo is one submit and works the same way with or without JavaScript. */}
      <form action={formAction} className="shrink-0">
        <input type="hidden" name="groupId" value={groupId} />
        <button
          type="submit"
          className="inline-flex min-h-[44px] min-w-[44px] items-center px-space-2 text-base text-primary underline"
        >
          Undo
        </button>
      </form>
      {state?.formError ? (
        <p role="alert" className="w-full text-sm text-negative">
          {state.formError}
        </p>
      ) : null}
    </div>
  );
}
