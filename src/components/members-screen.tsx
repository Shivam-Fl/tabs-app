import Link from 'next/link';

import type { GroupRow, InviteRow, MemberRow, Membership } from '@/lib/access';
import { SETTLE_FIRST_MESSAGE } from '@/lib/balances';
import { formatMinor } from '@/lib/money';
import { Money, directionOf } from '@/components/ui';
import { LeaveButton, RemoveButton } from '@/components/member-actions';
import { AddPlaceholderForm, ClaimButton } from '@/components/placeholder-actions';
import { InviteLink } from '@/components/invite-link';
import { RenameGroupForm } from '@/components/rename-group-form';
import { ArchiveButton } from '@/components/archive-button';

/**
 * The members screen's body. Presentational and synchronous, like GroupOverview, so a component
 * test can render it as the owner and as a plain member and assert which controls each sees.
 *
 * Which controls a viewer gets is decided here from their membership; whether a write is
 * ALLOWED is decided by the action, against the database. Absent is not the same as refused, and
 * this file only does the first.
 */
export function MembersScreen({
  group,
  members,
  viewer,
  invite,
}: {
  group: GroupRow;
  members: MemberRow[];
  viewer: Membership;
  /**
   * The group's own invite link, read through a member-scoped query rather than carried on
   * GroupRow: the token is a secret, and a field on the group would travel to every screen that
   * reads one.
   */
  invite: InviteRow;
}) {
  return (
    <div className="flex flex-col gap-space-6">
      <header className="flex flex-col gap-space-1">
        <Link
          href={`/groups/${group.id}`}
          className="inline-flex min-h-[44px] items-center text-base text-text-muted"
        >
          ← {group.name}
        </Link>
        <h1>Members</h1>
        <p className="text-sm text-text-muted">{group.name}</p>
      </header>

      <ul className="flex flex-col">
        {members.map((member) => {
          const isSelf = member.memberId === viewer.memberId;
          const settled = member.balanceMinor === 0n;
          /**
           * The two controls TR-13 gates, and only on the rows that would carry one: the
           * viewer's own Leave, or the owner's Remove on somebody else's row. A plain member
           * looking at another member is offered nothing either way, so there is no control to
           * withhold and nothing to explain — the sentence below is for the person who would
           * otherwise have had the button.
           */
          const gatedControl = (isSelf && !member.isOwner) || (viewer.isOwner && !isSelf);
          return (
            <li
              key={member.memberId}
              className="flex min-h-[44px] flex-wrap items-center justify-between gap-space-2 border-b border-border py-space-3 last:border-b-0"
            >
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{member.displayName}</span>
                {/* The role line is also where a placeholder is marked. 'Placeholder' rather
                    than 'Member' because it is the thing about the row that needs acting on:
                    somebody was added by name and has no account yet. */}
                <span className="text-sm text-text-muted">
                  {member.isPlaceholder ? 'Placeholder' : member.isOwner ? 'Owner' : 'Member'}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-space-2">
                {/* The viewer's own row reads in the second person and everybody else's in the
                    third, so a table of names never says "you" down the whole column. */}
                <Money
                  formatted={formatMinor(member.balanceMinor, group.currency)}
                  direction={directionOf(member.balanceMinor)}
                  voice={isSelf ? 'you' : 'person'}
                />
                {/* Leave appears on the viewer's own row and only for a member: the owner has
                    no Leave, and sees the line below instead. Remove appears on somebody
                    else's row and only for the owner. Claim is the mirror of Remove: it
                    appears on somebody else's PLACEHOLDER row and only for a member, because
                    the owner has no duplicate row to merge into it — the action refuses an
                    owner for that same reason, which is why no viewer is offered a control
                    that could only ever fail. */}
                {isSelf && !member.isOwner && settled ? (
                  <LeaveButton groupId={group.id} groupName={group.name} />
                ) : null}
                {viewer.isOwner && !isSelf && settled ? (
                  <RemoveButton
                    groupId={group.id}
                    memberId={member.memberId}
                    memberName={member.displayName}
                  />
                ) : null}
                {!viewer.isOwner && member.isPlaceholder ? (
                  <ClaimButton
                    groupId={group.id}
                    memberId={member.memberId}
                    memberName={member.displayName}
                  />
                ) : null}
              </span>
              {/* TR-13's visible half. The control is gone rather than present-and-refused, and
                  the sentence that replaces it is the one the action returns if the write is
                  attempted anyway — a row that hid the button and said nothing would read as a
                  bug. Its own line, because the row is already 360px wide. */}
              {gatedControl && !settled ? (
                <p className="w-full text-sm text-text-muted">{SETTLE_FIRST_MESSAGE}</p>
              ) : null}
            </li>
          );
        })}
      </ul>

      {/* Everyone sees the link; only the owner sees the controls beside it. */}
      <InviteLink groupId={group.id} invite={invite} isOwner={viewer.isOwner} />

      {viewer.isOwner ? (
        <div className="flex flex-col gap-space-6">
          <section className="flex flex-col gap-space-2">
            <h2 className="text-xl">Add a member by name</h2>
            <p className="text-sm text-text-muted">
              For somebody who is not on Tabs yet. They join the group by claiming the entry once
              they have an account.
            </p>
            <AddPlaceholderForm groupId={group.id} />
          </section>

          {/* Nothing transfers ownership in this piece, so this is what an owner who wants out
              is told to do — and the same sentence the refused leave returns as a form error. */}
          <p className="text-base text-text-muted">
            You own this group. To stop using it, archive it — ownership transfer is not built yet.
          </p>

          <section className="flex flex-col gap-space-2">
            <h2 className="text-xl">Rename</h2>
            <RenameGroupForm groupId={group.id} name={group.name} />
          </section>

          <section className="flex flex-col gap-space-2">
            <h2 className="text-xl">Archive</h2>
            <p className="text-sm text-text-muted">
              Archiving hides the group from everyone&apos;s list. It stays readable by its link.
            </p>
            <ArchiveButton groupId={group.id} groupName={group.name} />
          </section>
        </div>
      ) : null}

      {/* Back to the group, so the screen is never a dead end for a plain member. */}
      <nav aria-label="Group" className="flex flex-wrap gap-space-2">
        <Link
          href={`/groups/${group.id}`}
          className="inline-flex min-h-[44px] items-center rounded-radius border border-border bg-surface px-space-4 font-medium"
        >
          Overview
        </Link>
      </nav>
    </div>
  );
}
