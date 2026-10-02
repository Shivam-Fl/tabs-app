import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { z } from 'zod';

import { database } from '@/db/client';
import { readDeletedExpenseDescription, readExpensesForGroup, readGroup } from '@/lib/access';
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
 *
 * ?deleted= names the expense that was just deleted, and nothing else — the same split the home
 * screen makes with ?left=. The sentence the list confirms with is resolved from that id on the
 * server, through the caller's own membership and the row's own deleted_at, so a forged id
 * renders nothing rather than words, and the id of a live expense cannot make the list claim it
 * was deleted.
 */
const paramsSchema = z.object({ id: z.string().uuid() });
const searchSchema = z.object({ deleted: z.string().uuid().optional() });

export default async function ExpensesPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) notFound();

  const db = await database();
  const group = await readGroup(db, parsed.data.id, user.id);
  if (!group) notFound();

  const deleted = searchSchema.safeParse(await searchParams);
  const deletedId = deleted.success ? (deleted.data.deleted ?? null) : null;
  const [expenses, deletedDescription] = await Promise.all([
    readExpensesForGroup(db, parsed.data.id, user.id),
    deletedId ? readDeletedExpenseDescription(db, parsed.data.id, deletedId, user.id) : null,
  ]);

  return (
    <ExpenseList group={group} expenses={expenses ?? []} deletedDescription={deletedDescription} />
  );
}
