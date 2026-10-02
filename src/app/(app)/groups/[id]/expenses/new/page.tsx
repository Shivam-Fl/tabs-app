import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';

import { database } from '@/db/client';
import { readGroup, readMembers } from '@/lib/access';
import { requireUser } from '@/lib/auth';
import { ExpenseForm } from '@/components/expense-form';

export const metadata: Metadata = { title: 'New expense · Tabs' };

/**
 * The new-expense screen.
 *
 * The members are read in the canonical order readMembers returns — owner first, then
 * created_at, then id — and handed to the form in that order rather than re-sorted here. That
 * order IS the order the picker renders and the order the server splits in, which is what makes
 * the remainder land on the same member on both sides of the wire (TR-3).
 *
 * Nothing on this screen arrives separately from anything else, so there is no partial state to
 * design: the group and its members are both read before the form renders.
 */
const paramsSchema = z.object({ id: z.string().uuid() });

export default async function NewExpensePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) notFound();

  const db = await database();
  const group = await readGroup(db, parsed.data.id, user.id);
  if (!group) notFound();

  const members = await readMembers(db, parsed.data.id, user.id);
  if (!members) notFound();

  // The server's own date, in UTC, as the calendar date the field starts on. There is no
  // timezone on a group in this version, so this is the one clock the app has; the date is
  // stored as a calendar date and is never shifted through a Date, so it cannot reorder.
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="flex flex-col gap-space-6">
      <header className="flex flex-col gap-space-1">
        <Link
          href={`/groups/${group.id}/expenses`}
          className="inline-flex min-h-[44px] items-center text-base text-text-muted"
        >
          ← Expenses
        </Link>
        <h1>Add expense</h1>
        <p className="text-sm text-text-muted">{group.name}</p>
      </header>

      <ExpenseForm
        group={{ id: group.id, name: group.name, currency: group.currency }}
        members={members.map((member) => ({
          memberId: member.memberId,
          displayName: member.displayName,
        }))}
        today={today}
      />
    </div>
  );
}
