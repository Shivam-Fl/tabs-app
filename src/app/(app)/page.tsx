import { z } from 'zod';

import { database } from '@/db/client';
import { listGroupsForUser, readBalancesForGroup, readRecentLeave } from '@/lib/access';
import { requireUser } from '@/lib/auth';
import { simplifyDebts, sumBalances, summariseForViewer, type ViewerGroupBalances } from '@/lib/balances';
import { GroupList } from '@/components/group-list';

/**
 * The home screen: what the caller owes and is owed across everything, then their groups.
 *
 * The queries live here rather than in GroupList because a page can await the database and a
 * presentational component cannot — the split is what lets the list be rendered by a test.
 *
 * ?left= names the group the caller just left, and nothing else: the name shown comes from
 * readRecentLeave, which resolves it through the caller's own membership and their own leave
 * inside the last ten seconds. A forged or stale id renders no notice rather than a name.
 */
const searchSchema = z.object({ left: z.string().uuid().optional() });

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const db = await database();

  const parsed = searchSchema.safeParse(await searchParams);
  const leftGroupId = parsed.success ? (parsed.data.left ?? null) : null;
  const leftGroupName = leftGroupId ? await readRecentLeave(db, user.id, leftGroupId) : null;

  const groups = await listGroupsForUser(db, user.id);

  /**
   * Each group's balances are read independently and settled here, so one group failing costs
   * that group's row and nothing else (docs/ui.md, Home · partial). allSettled rather than all
   * because `all` would reject the moment the first read did and take the other nine groups
   * down with it — which is the failure mode the design document names.
   *
   * A read that returns null for a group the caller is demonstrably in, or balances that do not
   * sum to zero, is this code's own defect rather than a group that happens to look odd, so
   * both are thrown and land in the same per-group rejection as a database error.
   */
  const results = await Promise.allSettled(
    groups.map(async (group): Promise<ViewerGroupBalances> => {
      const balances = await readBalancesForGroup(db, group.id, user.id);
      if (!balances) throw new Error('tabs: balances were unreadable for a group the caller is in.');
      if (sumBalances(balances.members) !== 0n) {
        throw new Error("tabs: this group's balances do not sum to zero, so no settlement can be produced.");
      }
      return {
        viewerMemberId: balances.viewerMemberId,
        members: balances.members,
        transfers: simplifyDebts(balances.members),
      };
    }),
  );

  const loaded: ViewerGroupBalances[] = [];
  const failedGroupIds: string[] = [];
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') loaded.push(result.value);
    else failedGroupIds.push(groups[index].id);
  });

  // Withheld, not partial: the two figures are claims about everything the caller has, and a
  // total over the groups that answered would be a number that changes when a group stops
  // failing. The failing rows below say which groups are missing.
  const summary = failedGroupIds.length === 0 ? summariseForViewer(loaded) : null;

  return (
    <GroupList
      groups={groups}
      summary={summary}
      summaryCurrency={groups[0]?.currency ?? user.defaultCurrency}
      failedGroupIds={failedGroupIds}
      leftGroupId={leftGroupId}
      leftGroupName={leftGroupName}
    />
  );
}
