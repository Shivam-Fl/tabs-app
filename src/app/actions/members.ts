'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { database } from '@/db/client';
import { recordActivity } from '@/lib/activity';
import {
  endMembership,
  readLastMembershipActivity,
  readMembership,
  readRemovedMembership,
  removeMemberAsOwner,
  restoreMembership,
} from '@/lib/access';
import { requireUser } from '@/lib/auth';

/**
 * Leaving, undoing a leave, and removing somebody else.
 *
 * Same shape as groups.ts: a typed result, no throw for an expected refusal, no redirect from
 * inside a transaction body.
 */

export interface MemberResult {
  ok: boolean;
  fieldErrors?: Record<string, string>;
  formError?: string;
  /** Set on success: the group the change happened in, for the client to navigate with. */
  groupId?: string;
}

const groupIdSchema = z.string().uuid();
const memberIdSchema = z.string().uuid();

const leaveGroupSchema = z.object({ groupId: groupIdSchema });
const removeMemberSchema = z.object({ groupId: groupIdSchema, memberId: memberIdSchema });

function fieldErrorsFrom(error: z.ZodError): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    fieldErrors[String(issue.path[0] ?? 'form')] ??= issue.message;
  }
  return fieldErrors;
}

export async function leaveGroup(_previous: MemberResult | null, formData: FormData): Promise<MemberResult> {
  const parsed = leaveGroupSchema.safeParse({ groupId: formData.get('groupId') });
  if (!parsed.success) return { ok: false, fieldErrors: fieldErrorsFrom(parsed.error) };

  const user = await requireUser();
  const db = await database();
  const groupId = parsed.data.groupId;

  const left = await db.transaction(async (tx) => {
    const membership = await readMembership(tx, groupId, user.id);
    if (!membership) return false;

    // The owner cannot leave. Nothing in this piece transfers ownership, so a group whose owner
    // left would be a group with no owner — the partial unique index still counts their row in
    // the slot. The screen offers them archive or a transfer that does not exist yet instead.
    if (membership.isOwner) return 'owner' as const;

    if (!(await endMembership(tx, membership.memberId, user.id))) return false;

    // The row stays with removed_at set; the entry is what authorises Undo and what the home
    // page's leave notice is resolved from.
    await recordActivity(tx, { groupId, actorId: user.id, kind: 'member.left', memberId: membership.memberId });
    return true;
  });

  if (left === 'owner') {
    return { ok: false, formError: "You own this group, so you can't leave it. Archive it instead." };
  }
  if (!left) return { ok: false, formError: 'You are not a member of this group.' };

  revalidatePath('/', 'layout');
  return { ok: true, groupId };
}

export async function undoLeave(_previous: MemberResult | null, formData: FormData): Promise<MemberResult> {
  const parsed = leaveGroupSchema.safeParse({ groupId: formData.get('groupId') });
  if (!parsed.success) return { ok: false, fieldErrors: fieldErrorsFrom(parsed.error) };

  const user = await requireUser();
  const db = await database();
  const groupId = parsed.data.groupId;

  const undone = await db.transaction(async (tx) => {
    // The REMOVED row, not the active one: the membership this undoes is by definition not
    // active, so a read of the active row finds nothing and undo can never succeed. Joining
    // again in the meantime leaves an active row too, and restoreMembership refuses then.
    const membership = await readRemovedMembership(tx, groupId, user.id);
    if (!membership) return false;

    /**
     * Undo is authorised by the feed, not by the row: removed_at only says the membership
     * ended, and it ended for the same reason after a completed undo followed by an owner's
     * removal. What authorises restoring it is that the LAST thing to happen to this membership
     * was the caller's own leave, so a stale member.left cannot undo a decision the owner has
     * made since — and an undo cannot be replayed.
     */
    const last = await readLastMembershipActivity(tx, membership.memberId);
    if (!last || last.kind !== 'member.left' || last.actorId !== user.id) return false;

    if (!(await restoreMembership(tx, groupId, membership.memberId, user.id))) return false;

    await recordActivity(tx, { groupId, actorId: user.id, kind: 'member.joined', memberId: membership.memberId });
    return true;
  });

  if (!undone) return { ok: false, formError: 'That leave can no longer be undone.' };

  revalidatePath('/', 'layout');
  return { ok: true, groupId };
}

export async function removeMember(_previous: MemberResult | null, formData: FormData): Promise<MemberResult> {
  const parsed = removeMemberSchema.safeParse({
    groupId: formData.get('groupId'),
    memberId: formData.get('memberId'),
  });
  if (!parsed.success) return { ok: false, fieldErrors: fieldErrorsFrom(parsed.error) };

  const user = await requireUser();
  const db = await database();
  const { groupId, memberId } = parsed.data;

  const removed = await db.transaction(async (tx) => {
    const membership = await readMembership(tx, groupId, user.id);
    if (!membership?.isOwner) return false;

    if (!(await removeMemberAsOwner(tx, groupId, memberId, membership))) return false;

    await recordActivity(tx, { groupId, actorId: user.id, kind: 'member.removed', memberId });
    return true;
  });

  if (!removed) return { ok: false, formError: 'That member could not be removed.' };

  revalidatePath('/', 'layout');
  return { ok: true, groupId };
}
