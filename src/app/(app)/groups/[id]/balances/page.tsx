import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { z } from 'zod';

import { database } from '@/db/client';
import { readBalancesForGroup, readGroup } from '@/lib/access';
import { requireUser } from '@/lib/auth';
import { simplifyDebts, sumBalances } from '@/lib/balances';
import { BalancesScreen } from '@/components/balances-screen';

export const metadata: Metadata = { title: 'Balances · Tabs' };

/**
 * The balances screen.
 *
 * The id is parsed here for the reason the overview gives: a route parameter is a boundary like
 * any other, and an id that is not a uuid would otherwise be a malformed-uuid error from
 * Postgres — a 500 — where the right answer is the same 404 a non-member gets.
 */
const paramsSchema = z.object({ id: z.string().uuid() });

export default async function BalancesPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) notFound();

  const db = await database();
  const group = await readGroup(db, parsed.data.id, user.id);
  if (!group) notFound();

  // Null means the caller is not an active member of this group, which is the same answer the
  // group read already gave: the group is not theirs to see.
  const balances = await readBalancesForGroup(db, parsed.data.id, user.id);
  if (!balances) notFound();

  /**
   * The sum is asserted BEFORE the settlement is asked for (TR-6, AC-12). Every expense puts
   * the same total into the paid rows and the shared rows, so an intact ledger always adds up
   * to zero and a non-zero sum means this read disagrees with what was written — a defect, and
   * not a group whose balances happen to be odd. Saying so here means a broken read renders the
   * error boundary's sentence rather than a settlement invented for money that is not there;
   * simplifyDebts throws on the same condition as the backstop for a caller that forgets.
   */
  if (sumBalances(balances.members) !== 0n) {
    throw new Error("tabs: this group's balances do not sum to zero, so no settlement can be produced.");
  }

  const transfers = simplifyDebts(balances.members);

  return <BalancesScreen group={group} members={balances.members} transfers={transfers} />;
}
