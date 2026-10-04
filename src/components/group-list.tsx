import Link from 'next/link';

import type { GroupSummary } from '@/lib/access';
import type { HomeSummaryTotals } from '@/lib/balances';
import { formatMinor } from '@/lib/money';
import { HomeEmpty } from '@/components/home-empty';
import { HomeGroupError } from '@/components/home-group-error';
import { HomeSummary } from '@/components/home-summary';
import { LeaveNotice } from '@/components/leave-notice';
import { LinkButton, Money, directionOf } from '@/components/ui';

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
  summary,
  summaryCurrency,
  failedGroupIds,
  leftGroupId,
  leftGroupName,
}: {
  groups: GroupSummary[];
  /**
   * The caller's two totals and their per-person breakdowns, or null when at least one group's
   * balances could not be read. Null is not "no balances": docs/ui.md is explicit that a total
   * of the groups that happened to load is a lie, so the block is withheld until every one of
   * them is in, and the failing row says why.
   */
  summary: HomeSummaryTotals | null;
  /** The groups' own currency, for the summary's figures. */
  summaryCurrency: string;
  /** The groups whose balances failed to load. Each renders its own inline error. */
  failedGroupIds: string[];
  /** The group named by ?left=, already resolved server-side against the caller's own leave. */
  leftGroupId: string | null;
  leftGroupName: string | null;
}) {
  /**
   * Only when the server resolved a name, which is only for the caller's own leave inside the
   * last ten seconds. A bare / and a stale ?left= both render nothing.
   *
   * Above BOTH branches, including the empty one: the group somebody just left is often the only
   * group they were in — a person's first invite, which is exactly what docs/ui.md's leaving
   * example describes — and returning HomeEmpty alone would take the notice, the only Undo
   * affordance for a reversible action, with it. HomeEmpty's h1 is still the only one either way.
   */
  const notice =
    leftGroupId && leftGroupName ? <LeaveNotice groupId={leftGroupId} groupName={leftGroupName} /> : null;

  if (groups.length === 0) {
    return (
      <div className="flex flex-col gap-space-6">
        {notice}
        <HomeEmpty />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-space-6">
      <div className="flex flex-wrap items-center justify-between gap-space-3">
        <h1>Your groups</h1>
        <LinkButton href="/groups/new">Create group</LinkButton>
      </div>

      {notice}

      {summary ? <HomeSummary totals={summary} currency={summaryCurrency} /> : null}

      <ul className="flex flex-col">
        {groups.map((group) =>
          failedGroupIds.includes(group.id) ? (
            // The row keeps the group's name and loses its link: there is no balance to show
            // beside it, and the group's own screen would fail the same way this row just did.
            <li key={group.id} className="border-b border-border last:border-b-0">
              <div className="flex min-h-[44px] items-center justify-between gap-space-3 py-space-3">
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{group.name}</span>
                  <span className="text-sm text-text-muted">{group.type}</span>
                </span>
              </div>
              <HomeGroupError />
            </li>
          ) : (
            <li key={group.id} className="border-b border-border last:border-b-0">
              <Link
                href={`/groups/${group.id}`}
                className="flex min-h-[44px] items-center justify-between gap-space-3 py-space-3"
              >
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{group.name}</span>
                  <span className="text-sm text-text-muted">{group.type}</span>
                </span>
                {/* The caller's own net in this group, read from the group's stored rows by
                    listGroupsForUser — the same definition the group's own screen uses, so the
                    two cannot disagree. */}
                <Money
                  formatted={formatMinor(group.balanceMinor, group.currency)}
                  direction={directionOf(group.balanceMinor)}
                  voice="you"
                />
              </Link>
            </li>
          ),
        )}
      </ul>
    </div>
  );
}
