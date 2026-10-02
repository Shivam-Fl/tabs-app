import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { z } from 'zod';

import { database } from '@/db/client';
import { readGroup, readMembers, readMembership } from '@/lib/access';
import { requireUser } from '@/lib/auth';
import { MembersScreen } from '@/components/members-screen';

export const metadata: Metadata = { title: 'Members · Tabs' };

/**
 * The members screen. The id is parsed here for the reason the overview gives, and every read
 * carries its own membership join, so a non-member gets the not-found page rather than an
 * empty list that would tell them the group exists.
 */
const paramsSchema = z.object({ id: z.string().uuid() });

export default async function MembersPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) notFound();

  const db = await database();
  const group = await readGroup(db, parsed.data.id, user.id);
  const membership = await readMembership(db, parsed.data.id, user.id);
  const members = await readMembers(db, parsed.data.id, user.id);
  if (!group || !membership || !members) notFound();

  return <MembersScreen group={group} members={members} viewer={membership} />;
}
