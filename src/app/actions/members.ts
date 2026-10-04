'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { database } from '@/db/client';
import { recordActivity } from '@/lib/activity';
import {
  addPlaceholderAsOwner,
  endMembership,
  joinGroupIfAbsent,
  mergeClaimPlaceholder,
  readLastMembershipActivity,
  readMembership,
  readNetBalanceForMember,
  readRemovedMembership,
  removeMemberAsOwner,
  resolveGroupByToken,
  restoreMembership,
  rotateInviteAsOwner,
  setInviteEnabledAsOwner,
  type ClaimRefusal,
} from '@/lib/access';
import { SETTLE_FIRST_MESSAGE } from '@/lib/balances';
import { requireUser } from '@/lib/auth';

/**
 * Everything a membership and a group's invite link do: joining through a link, adding somebody
 * by name, claiming a placeholder, leaving, undoing a leave, removing somebody else, and the
 * owner's control of the link itself.
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

/** The invite token as it arrives from a URL: base64url, and nothing else gets past the parse. */
const tokenSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

/** A placeholder's name: the same bounds the group's own name is held to. */
const placeholderNameSchema = z
  .string()
  .trim()
  .min(1, 'Enter a name to show for this member.')
  .max(80, 'That name is too long.');

const groupIdFormSchema = z.object({ groupId: groupIdSchema });
const removeMemberSchema = z.object({ groupId: groupIdSchema, memberId: memberIdSchema });
const joinSchema = z.object({ token: tokenSchema });
const addPlaceholderSchema = z.object({ groupId: groupIdSchema, name: placeholderNameSchema });
const claimSchema = z.object({ groupId: groupIdSchema, memberId: memberIdSchema });
const inviteToggleSchema = z.object({
  groupId: groupIdSchema,
  // A form field, so it arrives as the string 'true' or 'false' — never coerced, because
  // Boolean('false') is true and a coercion here would turn "turn it off" into "turn it on".
  enabled: z.enum(['true', 'false']).transform((value) => value === 'true'),
});

/** One sentence per refusal, so every way a claim can fail reads as a thing that happened. */
const CLAIM_REFUSALS: Record<ClaimRefusal, string> = {
  'not-a-member': 'You are not a member of this group.',
  owner: 'You own this group, so there is nobody to claim the placeholder on your behalf.',
  'already-claimed': 'That member has already been claimed.',
  'no-longer-available': 'That member is no longer in this group.',
};

const NOT_OWNER = 'Only the group’s owner can change the invite link.';

function fieldErrorsFrom(error: z.ZodError): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    fieldErrors[String(issue.path[0] ?? 'form')] ??= issue.message;
  }
  return fieldErrors;
}

/**
 * Joins the caller to the group an invite token names.
 *
 * The token is resolved INSIDE the transaction rather than passed in from the page that
 * rendered the confirm button, because the two are different requests: an owner can rotate the
 * link between the page loading and the button being pressed, and the answer to a token that is
 * no longer live is a sentence, not a 500. Neither is the join handed the group id — a token is
 * the only thing that proves which group this is.
 *
 * Confirming twice is a no-op, not a second membership and not a second feed entry: the second
 * call writes nothing because there is no change for it to record (TR-14).
 */
export async function joinWithToken(_previous: MemberResult | null, formData: FormData): Promise<MemberResult> {
  const parsed = joinSchema.safeParse({ token: formData.get('token') });
  if (!parsed.success) return { ok: false, formError: 'That invite link is not valid.' };

  const user = await requireUser();
  const db = await database();
  const { token } = parsed.data;

  const joined = await db.transaction(async (tx) => {
    const group = await resolveGroupByToken(tx, token);
    if (!group) return null;

    const memberId = await joinGroupIfAbsent(tx, group.id, user.id);
    if (memberId) {
      await recordActivity(tx, { groupId: group.id, actorId: user.id, kind: 'member.joined', memberId });
    }

    return group.id;
  });

  if (!joined) return { ok: false, formError: 'That invite link is no longer valid.' };

  revalidatePath('/', 'layout');
  return { ok: true, groupId: joined };
}

/**
 * Adds a member by name, before they have an account. Owner-only.
 *
 * The name is stored on the membership row and nowhere else: the column is read only while
 * there is no account behind the row, so it disappears from every screen the moment the
 * placeholder is claimed and its claimer's own profile name takes over.
 */
export async function addPlaceholderMember(
  _previous: MemberResult | null,
  formData: FormData,
): Promise<MemberResult> {
  const parsed = addPlaceholderSchema.safeParse({
    groupId: formData.get('groupId'),
    name: formData.get('name'),
  });
  if (!parsed.success) return { ok: false, fieldErrors: fieldErrorsFrom(parsed.error) };

  const user = await requireUser();
  const db = await database();
  const { groupId, name } = parsed.data;

  const created = await db.transaction(async (tx) => {
    const memberId = await addPlaceholderAsOwner(tx, groupId, name, user.id);
    if (!memberId) return null;

    await recordActivity(tx, {
      groupId,
      actorId: user.id,
      kind: 'member.placeholder_added',
      memberId,
    });
    return memberId;
  });

  if (!created) return { ok: false, formError: 'Only the group’s owner can add a member by name.' };

  revalidatePath('/', 'layout');
  return { ok: true, groupId };
}

/**
 * Claims a placeholder, merging the caller into it.
 *
 * The merge itself — end the caller's row, attach their user_id to the placeholder, restore
 * them if the attach lost — is one ordered transaction in access.ts. What this action adds is
 * the caller's membership, the one feed entry, and the sentence for each way it can be refused.
 */
export async function claimPlaceholder(_previous: MemberResult | null, formData: FormData): Promise<MemberResult> {
  const parsed = claimSchema.safeParse({
    groupId: formData.get('groupId'),
    memberId: formData.get('memberId'),
  });
  if (!parsed.success) return { ok: false, fieldErrors: fieldErrorsFrom(parsed.error) };

  const user = await requireUser();
  const db = await database();
  const { groupId, memberId } = parsed.data;

  const claimed = await db.transaction(async (tx) => {
    const membership = await readMembership(tx, groupId, user.id);
    if (!membership) return { ok: false as const, reason: 'not-a-member' as const };

    const result = await mergeClaimPlaceholder(tx, {
      groupId,
      placeholderMemberId: memberId,
      caller: membership,
    });

    if (result.ok) {
      await recordActivity(tx, { groupId, actorId: user.id, kind: 'member.claimed', memberId: result.memberId });
    }
    return result;
  });

  if (!claimed.ok) return { ok: false, formError: CLAIM_REFUSALS[claimed.reason] };

  revalidatePath('/', 'layout');
  return { ok: true, groupId };
}

/** Makes a new invite link, owner-only. The previous token stops resolving immediately. */
export async function rotateInviteLink(_previous: MemberResult | null, formData: FormData): Promise<MemberResult> {
  const parsed = groupIdFormSchema.safeParse({ groupId: formData.get('groupId') });
  if (!parsed.success) return { ok: false, fieldErrors: fieldErrorsFrom(parsed.error) };

  const user = await requireUser();
  const db = await database();
  const { groupId } = parsed.data;

  const rotated = await db.transaction(async (tx) => {
    const token = await rotateInviteAsOwner(tx, groupId, user.id);
    if (!token) return false;

    await recordActivity(tx, { groupId, actorId: user.id, kind: 'group.invite_rotated' });
    return true;
  });

  if (!rotated) return { ok: false, formError: NOT_OWNER };

  revalidatePath('/', 'layout');
  return { ok: true, groupId };
}

/**
 * Turns the invite link off, owner-only.
 *
 * Turning it back on is deliberately not this action. A token that has been retired stays
 * retired — reviving the string somebody may already have is the opposite of what turning a
 * link off is for — so the way back to a working link is to make a new one. That also keeps one
 * feed entry per invite change: rotating and disabling each have a kind, and re-enabling an
 * existing token has none.
 */
export async function setInviteEnabled(
  _previous: MemberResult | null,
  formData: FormData,
): Promise<MemberResult> {
  const parsed = inviteToggleSchema.safeParse({
    groupId: formData.get('groupId'),
    enabled: formData.get('enabled'),
  });
  if (!parsed.success) return { ok: false, fieldErrors: fieldErrorsFrom(parsed.error) };

  const user = await requireUser();
  const db = await database();
  const { groupId, enabled } = parsed.data;

  if (enabled) return { ok: false, formError: 'Make a new link to turn the invite back on.' };

  const disabled = await db.transaction(async (tx) => {
    if (!(await setInviteEnabledAsOwner(tx, groupId, false, user.id))) return false;

    await recordActivity(tx, { groupId, actorId: user.id, kind: 'group.invite_disabled' });
    return true;
  });

  if (!disabled) return { ok: false, formError: NOT_OWNER };

  revalidatePath('/', 'layout');
  return { ok: true, groupId };
}

export async function leaveGroup(_previous: MemberResult | null, formData: FormData): Promise<MemberResult> {
  const parsed = groupIdFormSchema.safeParse({ groupId: formData.get('groupId') });
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

    // TR-13's balance precondition, read INSIDE the transaction that would end the membership:
    // a balance read before it could be settled between the two requests. Nothing has been
    // written at this point, so a refusal here leaves the group exactly as it was.
    const balance = await readNetBalanceForMember(tx, groupId, membership.memberId, user.id);
    if (balance === null) return false;
    if (balance !== 0n) return 'not-settled' as const;

    if (!(await endMembership(tx, membership.memberId, user.id))) return false;

    // The row stays with removed_at set; the entry is what authorises Undo and what the home
    // page's leave notice is resolved from.
    await recordActivity(tx, { groupId, actorId: user.id, kind: 'member.left', memberId: membership.memberId });
    return true;
  });

  if (left === 'owner') {
    return { ok: false, formError: "You own this group, so you can't leave it. Archive it instead." };
  }
  if (left === 'not-settled') return { ok: false, formError: SETTLE_FIRST_MESSAGE };
  if (!left) return { ok: false, formError: 'You are not a member of this group.' };

  revalidatePath('/', 'layout');
  return { ok: true, groupId };
}

export async function undoLeave(_previous: MemberResult | null, formData: FormData): Promise<MemberResult> {
  const parsed = groupIdFormSchema.safeParse({ groupId: formData.get('groupId') });
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

    // The same TR-13 precondition as leaving, and the same sentence for it: a member with a
    // balance is refused by both paths, and the two must not explain the rule differently.
    const balance = await readNetBalanceForMember(tx, groupId, memberId, user.id);
    if (balance === null) return false;
    if (balance !== 0n) return 'not-settled' as const;

    if (!(await removeMemberAsOwner(tx, groupId, memberId, membership))) return false;

    await recordActivity(tx, { groupId, actorId: user.id, kind: 'member.removed', memberId });
    return true;
  });

  if (removed === 'not-settled') return { ok: false, formError: SETTLE_FIRST_MESSAGE };
  if (!removed) return { ok: false, formError: 'That member could not be removed.' };

  revalidatePath('/', 'layout');
  return { ok: true, groupId };
}
