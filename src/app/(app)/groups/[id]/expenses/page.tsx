import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { z } from 'zod';

import { database } from '@/db/client';
import { readExpensesForGroup, readGroup } from '@/lib/access';
import { requireUser } from '@/lib/auth';
import { ExpenseList } from '@/components/expense-list';

export const metadata: Metadata = { title: 'Expenses · Tabs' };

/**
 * The expenses list.
 *
 * The id is parsed here for the reason the overview gives: a route parameter is a boundary like
 * any other, and an id that is not a uuid would otherwise be a malformed-uuid error from
 * Postgres — a 500 — where the right answer is the same 404 a non-member gets.
 *
 * Both reads carry their own membership join, so a non-member gets the not-found page rather
 * than an empty list that would tell them the group exists.
 */
const paramsSchema = z.object({ id: z.string().uuid() });

export default async function ExpensesPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) notFound();

  const db = await database();
  const group = await readGroup(db, parsed.data.id, user.id);
  if (!group) notFound();

  const expenses = await readExpensesForGroup(db, parsed.data.id, user.id);

  return <ExpenseList group={group} expenses={expenses ?? []} />;
}
