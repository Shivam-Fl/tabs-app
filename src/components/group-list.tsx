import Link from 'next/link';

import type { GroupSummary } from '@/lib/access';
import { formatMinor } from '@/lib/money';
import { HomeEmpty } from '@/components/home-empty';
import { LeaveNotice } from '@/components/leave-notice';
import { LinkButton, Money } from '@/components/ui';

/**
 * The home list. Presentational and synchronous, like the pages' other bodies, so a component
 * test can render the composition the page actually produces.
 *
 * Its own h1 covers the non-empty branch, and HomeEmpty's covers the empty one. The shell
 * contributes no h1 (tests/components/ui.test.tsx asserts exactly one across it), so a list
 * that rendered neither branch would have no h1 at all — which is why the heading is here and
 * not left to the shell.
 */
export function GroupList({
  groups,
  leftGroupId,
  leftGroupName,
}: {
  groups: GroupSummary[];
  /** The group named by ?left=, already resolved server-side against the caller's own leave. */
  leftGroupId: string | null;
  leftGroupName: string | null;
}) {
  if (groups.length === 0) return <HomeEmpty />;

  return (
    <div className="flex flex-col gap-space-6">
      <div className="flex flex-wrap items-center justify-between gap-space-3">
        <h1>Your groups</h1>
        <LinkButton href="/groups/new">Create group</LinkButton>
      </div>

      {/* Only when the server resolved a name, which is only for the caller's own leave inside
          the last ten seconds. A bare / and a stale ?left= both render nothing. */}
      {leftGroupId && leftGroupName ? (
        <LeaveNotice groupId={leftGroupId} groupName={leftGroupName} />
      ) : null}

      <ul className="flex flex-col">
        {groups.map((group) => (
          <li key={group.id} className="border-b border-border last:border-b-0">
            <Link
              href={`/groups/${group.id}`}
              className="flex min-h-[44px] items-center justify-between gap-space-3 py-space-3"
            >
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{group.name}</span>
                <span className="text-sm text-text-muted">{group.type}</span>
              </span>
              <Money formatted={formatMinor(group.balanceMinor, group.currency)} direction="settled" />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
