import { z } from 'zod';

import { database } from '@/db/client';
import { listGroupsForUser, readRecentLeave } from '@/lib/access';
import { requireUser } from '@/lib/auth';
import { GroupList } from '@/components/group-list';

/**
 * The home screen: the caller's groups, newest activity first.
 *
 * The query lives here rather than in GroupList because a page can await the database and a
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

  return <GroupList groups={groups} leftGroupId={leftGroupId} leftGroupName={leftGroupName} />;
}
