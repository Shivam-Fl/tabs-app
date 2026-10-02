'use client';

import { useActionState, useEffect, useRef, useState } from 'react';

import { rotateInviteLink, setInviteEnabled } from '@/app/actions/members';
import type { MemberResult } from '@/app/actions/members';
import { Button, Input } from '@/components/ui';
import type { InviteRow } from '@/lib/access';

/**
 * The group's invite link, with Copy as the primary action and the owner's controls for
 * replacing or retiring it.
 *
 * A Client Component because both halves are browser work: the clipboard, and a confirmation
 * that appears in place rather than on another screen. Whether the OWNER CONTROLS render is
 * decided by the caller from the viewer's membership, the way every other control on this
 * screen is; the actions refuse an owner regardless, because a control that is hidden is not
 * the same as a write that is refused.
 */

/** What Copy says once it has been pressed. */
type CopyFeedback = 'idle' | 'copied' | 'manual';

export function InviteLink({ groupId, invite, isOwner }: { groupId: string; invite: InviteRow; isOwner: boolean }) {
  const field = useRef<HTMLDivElement>(null);
  const [feedback, setFeedback] = useState<CopyFeedback>('idle');
  const [origin, setOrigin] = useState('');

  const [rotateState, rotateAction, rotating] = useActionState<MemberResult | null, FormData>(rotateInviteLink, null);
  const [toggleState, toggleAction, toggling] = useActionState<MemberResult | null, FormData>(setInviteEnabled, null);

  // The browser's origin rather than the server's: the same build is served from localhost, a
  // preview host and production, and the link that gets shared has to be the one that works
  // where it is being shared. Filled in after mount, so the served HTML and the first client
  // render agree — and the TOKEN is in both, which is the part that must never flash as
  // missing. Only the origin arrives a tick later.
  useEffect(() => setOrigin(window.location.origin), []);

  const path = `/join/${invite.token}`;
  const url = `${origin}${path}`;

  // A new token is a new link. The confirmation was about the one that no longer exists, so it
  // does not carry over and claim a copy nobody made.
  useEffect(() => setFeedback('idle'), [url]);

  async function copyLink() {
    const input = field.current?.querySelector('input');
    input?.select();

    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(url);
      setFeedback('copied');
    } catch {
      // Denied, absent, or not a secure context. The text is already selected, so a manual copy
      // is one keystroke — and saying that is more honest than a "Copied" that copied nothing.
      const copied = typeof document.execCommand === 'function' && document.execCommand('copy');
      setFeedback(copied ? 'copied' : 'manual');
    }
  }

  return (
    <section className="flex flex-col gap-space-2">
      <h2 className="text-xl">Invite</h2>

      {invite.enabled ? (
        <>
          <p className="text-sm text-text-muted">Anyone with this link can join the group.</p>
          <div ref={field} className="flex flex-col gap-space-2 sm:flex-row sm:items-end">
            <div className="min-w-0 flex-1">
              <Input
                label="Invite link"
                readOnly
                value={url}
                onFocus={(event) => event.currentTarget.select()}
              />
            </div>
            <Button onClick={() => void copyLink()} busyLabel="Copying…">
              Copy link
            </Button>
          </div>
          {/* An aria-live region rather than a swap: it is announced, and it does not move the
              button out from under the finger that just pressed it. */}
          <p role="status" aria-live="polite" className="min-h-[24px] text-sm text-text-muted">
            {feedback === 'copied' ? 'Link copied.' : null}
            {feedback === 'manual' ? 'Press Ctrl/Cmd+C to copy the selected link.' : null}
          </p>
        </>
      ) : (
        // The token is deliberately not shown while the link is off: it no longer resolves, and
        // offering something to copy that cannot be used is worse than offering nothing.
        <p className="text-base text-text-muted">
          The invite link is turned off, so nobody can join with it. Make a new one to invite
          somebody.
        </p>
      )}

      {isOwner ? (
        <div className="flex flex-wrap gap-space-2">
          <form action={rotateAction}>
            <input type="hidden" name="groupId" value={groupId} />
            <Button type="submit" variant="secondary" disabled={rotating} busyLabel="Making…">
              {invite.enabled ? 'Make a new link' : 'Make a link'}
            </Button>
          </form>
          {invite.enabled ? (
            <form action={toggleAction}>
              <input type="hidden" name="groupId" value={groupId} />
              <input type="hidden" name="enabled" value="false" />
              <Button type="submit" variant="destructive" disabled={toggling} busyLabel="Turning off…">
                Turn off link
              </Button>
            </form>
          ) : null}
        </div>
      ) : null}

      {rotateState?.formError ? (
        <p role="alert" className="text-sm text-negative">
          {rotateState.formError}
        </p>
      ) : null}
      {toggleState?.formError ? (
        <p role="alert" className="text-sm text-negative">
          {toggleState.formError}
        </p>
      ) : null}
    </section>
  );
}
