import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { z } from 'zod';

import { database } from '@/db/client';
import { readBalancesForGroup, readGroup, readRecentActivity } from '@/lib/access';
import { requireUser } from '@/lib/auth';
import { simplifyDebts, sumBalances } from '@/lib/balances';
import { GroupOverview } from '@/components/group-overview';

export const metadata: Metadata = { title: 'Group · Tabs' };

/**
 * The group overview.
 *
 * A route parameter is a boundary like any other, so the id is parsed before it reaches the
 * database: an id that is not a uuid would otherwise be a malformed-uuid error from Postgres —
 * a 500 — where the right answer is the same 404 a non-member gets.
 *
 * notFound() is called outside any transaction, which is the rule the actions' comments give:
 * it throws NEXT_NOT_FOUND, and a throw inside a transaction body rolls the whole body back.
 */
const paramsSchema = z.object({ id: z.string().uuid() });

export default async function GroupPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) notFound();

  const db = await database();
  const group = await readGroup(db, parsed.data.id, user.id);
  if (!group) notFound();

  // The same read the balances screen makes, so the summary and the transfers here are the
  // figures that screen shows rather than a second computation that could disagree with it.
  const balances = await readBalancesForGroup(db, parsed.data.id, user.id);
  if (!balances) notFound();

  // Asserted before the settlement is asked for, exactly as the balances page does it (TR-6).
  // The overview renders amounts a person acts on, so a read that disagrees with itself has to
  // reach the error boundary rather than print a settlement for money that is not there.
  if (sumBalances(balances.members) !== 0n) {
    throw new Error("tabs: this group's balances do not sum to zero, so no settlement can be produced.");
  }

  const transfers = simplifyDebts(balances.members);
  const entries = await readRecentActivity(db, parsed.data.id, user.id, 5);

  return (
    <GroupOverview
      group={group}
      members={balances.members}
      transfers={transfers}
      entries={entries}
    />
  );
}
