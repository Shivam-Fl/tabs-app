import Link from 'next/link';

import type { GroupRow, MemberRow, Membership } from '@/lib/access';
import { formatMinor } from '@/lib/money';
import { Money } from '@/components/ui';
import { LeaveButton, RemoveButton } from '@/components/member-actions';
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
}: {
  group: GroupRow;
  members: MemberRow[];
  viewer: Membership;
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
          return (
            <li
              key={member.memberId}
              className="flex min-h-[44px] flex-wrap items-center justify-between gap-space-2 border-b border-border py-space-3 last:border-b-0"
            >
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{member.displayName}</span>
                <span className="text-sm text-text-muted">{member.isOwner ? 'Owner' : 'Member'}</span>
              </span>
              <span className="flex shrink-0 items-center gap-space-2">
                <Money formatted={formatMinor(member.balanceMinor, group.currency)} direction="settled" />
                {/* Leave appears on the viewer's own row and only for a member: the owner has
                    no Leave, and sees the line below instead. Remove appears on somebody
                    else's row and only for the owner. */}
                {isSelf && !member.isOwner ? (
                  <LeaveButton groupId={group.id} groupName={group.name} />
                ) : null}
                {viewer.isOwner && !isSelf ? (
                  <RemoveButton
                    groupId={group.id}
                    memberId={member.memberId}
                    memberName={member.displayName}
                  />
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>

      {viewer.isOwner ? (
        <div className="flex flex-col gap-space-6">
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
