import { randomBytes, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, notInArray, sql } from 'drizzle-orm';

import type { Database } from '@/db/client';
import { activity, groups, members, users, type ActivityKind, type GroupType } from '@/db/schema';
import type { Tx } from '@/lib/activity';

/**
 * The authorisation boundary. Every read and every write of a group, of a membership or of a
 * group's feed goes through this module, and no other module in src/ imports the groups or the
 * members table at all.
 *
 * TR-1 requires the check to be a membership join INSIDE the query rather than a read followed
 * by a decision, because the second shape is the one that gets skipped: somebody adds a new
 * page, reads the group by id, and forgets the second half. Here there is no function that
 * takes a group id and returns data without the join, so there is nothing to forget.
 *
 * Both the pool session and a transaction satisfy `Session`, so an action can run the same
 * reads inside the transaction that does its write.
 */
export type Session = Database | Tx;

/** How long the home page's leave notice may render for, and how recent a leave must be to show. */
export const LEAVE_NOTICE_MS = 10_000;

/** The kinds that describe a membership changing, which is what undo is authorised against. */
const MEMBERSHIP_KINDS = ['member.joined', 'member.left', 'member.removed'] as const;

/** The group's own lifecycle. Excluded from the overview's recent-activity block. */
const GROUP_LIFECYCLE_KINDS = ['group.created', 'group.renamed', 'group.archived'] as const;

export interface Membership {
  memberId: string;
  groupId: string;
  userId: string;
  isOwner: boolean;
}

export interface GroupRow {
  id: string;
  name: string;
  currency: string;
  type: GroupType;
  archivedAt: Date | null;
}

export interface MemberRow {
  memberId: string;
  displayName: string;
  isOwner: boolean;
  /**
   * Always zero in this piece: there are no expense or payment rows to sum, so a balance reads
   * from a literal rather than from a computation over nothing. Piece 6 replaces the literal
   * with the figure and this signature does not change.
   */
  balanceMinor: bigint;
}

export interface GroupSummary {
  id: string;
  name: string;
  type: GroupType;
  currency: string;
  balanceMinor: bigint;
}

export interface ActivityRow {
  id: string;
  kind: ActivityKind;
  actorId: string | null;
  actorName: string | null;
  memberId: string | null;
  createdAt: Date;
}

// --- write scope predicates ---------------------------------------------------------

/**
 * The predicate that makes a write owner-scoped: the caller holds an active owner membership
 * in this group. Expressed as SQL rather than as a read the caller then trusts, so it travels
 * with the UPDATE and cannot be separated from it.
 */
export function ownedByCaller(groupId: string, userId: string) {
  return sql`exists (select 1 from ${members} where ${members.groupId} = ${groupId} and ${members.userId} = ${userId} and ${members.isOwner} and ${members.removedAt} is null)`;
}

/** The same for a write any active member may make. */
export function memberOfGroup(groupId: string, userId: string) {
  return sql`exists (select 1 from ${members} where ${members.groupId} = ${groupId} and ${members.userId} = ${userId} and ${members.removedAt} is null)`;
}

// --- reads --------------------------------------------------------------------------

/**
 * The caller's active membership in a group, or null. This is the read the actions use to
 * decide which controls a request may use; the pages do not need it, because every read below
 * carries its own join.
 */
export async function readMembership(
  session: Session,
  groupId: string,
  userId: string,
): Promise<Membership | null> {
  const rows = await session
    .select({ memberId: members.id, isOwner: members.isOwner })
    .from(members)
    .where(and(eq(members.groupId, groupId), eq(members.userId, userId), isNull(members.removedAt)))
    .limit(1);

  const row = rows[0];
  return row ? { memberId: row.memberId, groupId, userId, isOwner: row.isOwner } : null;
}

/**
 * The caller's most recently ENDED membership in a group, or null.
 *
 * Undo cannot start from readMembership: the state it undoes is precisely the one where there
 * is no active membership, because removed_at is set. This is the only read in this module that
 * returns a removed row, and it is what the leave notice and the undo both resolve through.
 *
 * The most recent one, because a person may have left and rejoined more than once: the row
 * whose last activity is checked is the row that was actually ended last.
 */
export async function readRemovedMembership(
  session: Session,
  groupId: string,
  userId: string,
): Promise<Membership | null> {
  const rows = await session
    .select({ memberId: members.id, isOwner: members.isOwner })
    .from(members)
    .where(and(eq(members.groupId, groupId), eq(members.userId, userId), isNotNull(members.removedAt)))
    .orderBy(desc(members.removedAt), desc(members.createdAt))
    .limit(1);

  const row = rows[0];
  return row ? { memberId: row.memberId, groupId, userId, isOwner: row.isOwner } : null;
}

/** The group, for a caller who is an active member of it. Null for everybody else. */
export async function readGroup(session: Session, groupId: string, userId: string): Promise<GroupRow | null> {
  const rows = await session
    .select({
      id: groups.id,
      name: groups.name,
      currency: groups.currency,
      type: groups.type,
      archivedAt: groups.archivedAt,
    })
    .from(groups)
    // The join IS the authorisation: a non-member's row survives no step of this query.
    .innerJoin(members, and(eq(members.groupId, groups.id), eq(members.userId, userId), isNull(members.removedAt)))
    .where(eq(groups.id, groupId))
    .limit(1);

  return rows[0] ?? null;
}

/** The group's active members, owner first. Null for a caller who is not a member. */
export async function readMembers(session: Session, groupId: string, userId: string): Promise<MemberRow[] | null> {
  const membership = await readMembership(session, groupId, userId);
  if (!membership) return null;

  const rows = await session
    .select({ memberId: members.id, displayName: users.displayName, isOwner: members.isOwner })
    .from(members)
    .leftJoin(users, eq(users.id, members.userId))
    .where(and(eq(members.groupId, groupId), isNull(members.removedAt)))
    .orderBy(desc(members.isOwner), asc(members.createdAt));

  return rows.map((row) => ({
    memberId: row.memberId,
    // A placeholder has no account to take a name from yet; piece 5 gives it one.
    displayName: row.displayName ?? 'Member',
    isOwner: row.isOwner,
    balanceMinor: 0n,
  }));
}

/**
 * The caller's groups, newest activity first — a group with no activity at all sorts last
 * rather than first, which is what NULLS LAST is for: `DESC` alone would put every group that
 * nothing has ever happened in above the ones something just happened in.
 */
export async function listGroupsForUser(session: Session, userId: string): Promise<GroupSummary[]> {
  const rows = await session
    .select({ id: groups.id, name: groups.name, type: groups.type, currency: groups.currency })
    .from(groups)
    .innerJoin(members, and(eq(members.groupId, groups.id), eq(members.userId, userId), isNull(members.removedAt)))
    .leftJoin(activity, eq(activity.groupId, groups.id))
    .where(isNull(groups.archivedAt))
    .groupBy(groups.id)
    .orderBy(sql`max(${activity.createdAt}) desc nulls last`, desc(groups.createdAt));

  return rows.map((row) => ({ ...row, balanceMinor: 0n }));
}

/**
 * The group's recent feed, five entries by default, newest first, with the group's own
 * lifecycle excluded — a new group's only entries are its creation, and the overview's empty
 * state is specified to read "Nothing here yet". Empty for a caller who is not a member, since
 * their join matches nothing.
 */
export async function readRecentActivity(
  session: Session,
  groupId: string,
  userId: string,
  limit = 5,
): Promise<ActivityRow[]> {
  return await session
    .select({
      id: activity.id,
      kind: activity.kind,
      actorId: activity.actorId,
      actorName: users.displayName,
      memberId: activity.memberId,
      createdAt: activity.createdAt,
    })
    .from(activity)
    .innerJoin(
      members,
      and(eq(members.groupId, activity.groupId), eq(members.userId, userId), isNull(members.removedAt)),
    )
    .leftJoin(users, eq(users.id, activity.actorId))
    .where(and(eq(activity.groupId, groupId), notInArray(activity.kind, [...GROUP_LIFECYCLE_KINDS])))
    // `id` breaks a tie on the timestamp, which two entries written by the same transaction
    // share: now() is the transaction's start time, not each statement's.
    .orderBy(desc(activity.createdAt), desc(activity.id))
    .limit(limit);
}

/**
 * The name of a group the caller left within the last ten seconds, or null.
 *
 * The URL carries the group's id and never its name, so a name cannot be forged into the page
 * and a group the caller never left cannot be named — the guard is the last thing that happened
 * to the caller's own membership being their own leave, which is the same condition undo is
 * authorised by. A reload, a second tab or the back button therefore cannot resurrect the row
 * past its window, and a stale ?left= renders nothing at all.
 */
export async function readRecentLeave(
  session: Session,
  userId: string,
  groupId: string,
): Promise<string | null> {
  const rows = await session
    .select({ name: groups.name, kind: activity.kind, actorId: activity.actorId, createdAt: activity.createdAt })
    .from(members)
    .innerJoin(groups, eq(groups.id, members.groupId))
    .innerJoin(
      activity,
      and(eq(activity.memberId, members.id), inArray(activity.kind, [...MEMBERSHIP_KINDS])),
    )
    .where(
      and(
        eq(members.groupId, groupId),
        eq(members.userId, userId),
        isNotNull(members.removedAt),
      ),
    )
    .orderBy(desc(activity.createdAt), desc(activity.id))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  if (row.kind !== 'member.left' || row.actorId !== userId) return null;
  if (row.createdAt.getTime() <= Date.now() - LEAVE_NOTICE_MS) return null;
  return row.name;
}

/** The last thing that happened to a membership row, of the kinds undo is authorised against. */
export async function readLastMembershipActivity(
  session: Session,
  memberId: string,
): Promise<{ kind: ActivityKind; actorId: string | null } | null> {
  const rows = await session
    .select({ kind: activity.kind, actorId: activity.actorId })
    .from(activity)
    .where(and(eq(activity.memberId, memberId), inArray(activity.kind, [...MEMBERSHIP_KINDS])))
    .orderBy(desc(activity.createdAt), desc(activity.id))
    .limit(1);

  return rows[0] ?? null;
}

// --- writes -------------------------------------------------------------------------

/** A fresh invite token: 32 random bytes, base64url, so it is URL-safe and unguessable. */
export function newInviteToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Creates a group and its owner's membership row in one statement each, on the caller's
 * transaction. Returns the new group's id — generated here rather than read back, because
 * `.returning(fields)` resolves to the zero-argument overload on a union of the two drivers
 * and fails to typecheck (see insertUser in src/db/client.ts).
 */
export async function createGroupWithOwner(
  tx: Tx,
  input: { name: string; currency: string; type: GroupType; ownerId: string },
): Promise<string> {
  const groupId = randomUUID();
  const memberId = randomUUID();

  await tx.insert(groups).values({
    id: groupId,
    name: input.name,
    currency: input.currency,
    type: input.type,
    inviteToken: newInviteToken(),
  });

  await tx.insert(members).values({ id: memberId, groupId, userId: input.ownerId, isOwner: true });

  return groupId;
}

/** Renames a group the caller owns. False when they do not own it, with nothing written. */
export async function renameGroupAsOwner(
  tx: Tx,
  groupId: string,
  name: string,
  userId: string,
): Promise<boolean> {
  const updated = await tx
    .update(groups)
    .set({ name })
    .where(and(eq(groups.id, groupId), ownedByCaller(groupId, userId)))
    .returning();

  return updated.length > 0;
}

/** Archives a group the caller owns. False when they do not own it, with nothing written. */
export async function archiveGroupAsOwner(
  tx: Tx,
  groupId: string,
  userId: string,
): Promise<boolean> {
  const updated = await tx
    .update(groups)
    .set({ archivedAt: new Date() })
    .where(and(eq(groups.id, groupId), ownedByCaller(groupId, userId)))
    .returning();

  return updated.length > 0;
}

/** Ends a membership by setting removed_at. The row is never deleted (TR-16). */
export async function endMembership(tx: Tx, memberId: string, userId: string): Promise<boolean> {
  const updated = await tx
    .update(members)
    .set({ removedAt: new Date() })
    .where(and(eq(members.id, memberId), eq(members.userId, userId), isNull(members.removedAt)))
    .returning();

  return updated.length > 0;
}

/**
 * Restores a membership by clearing removed_at.
 *
 * The `not exists` clause is what keeps Undo from raising a unique violation when the person
 * already has another active membership in the group: there is then nothing to restore, so
 * this writes nothing and reports false rather than corrupting the row or throwing.
 */
export async function restoreMembership(
  tx: Tx,
  groupId: string,
  memberId: string,
  userId: string,
): Promise<boolean> {
  const updated = await tx
    .update(members)
    .set({ removedAt: null })
    .where(
      and(
        eq(members.id, memberId),
        eq(members.groupId, groupId),
        eq(members.userId, userId),
        isNotNull(members.removedAt),
        sql`not exists (select 1 from ${members} where ${members.groupId} = ${groupId} and ${members.userId} = ${userId} and ${members.removedAt} is null and ${members.id} <> ${memberId})`,
      ),
    )
    .returning();

  return updated.length > 0;
}

/**
 * Removes another member, owner-only.
 *
 * The caller's own membership row is excluded twice over — by `is_owner = false`, and by the
 * explicit id comparison — because removing it would leave the group with no owner while the
 * partial unique index still considered the slot taken, and nothing in this piece can promote
 * a new one.
 */
export async function removeMemberAsOwner(
  tx: Tx,
  groupId: string,
  memberId: string,
  caller: Membership,
): Promise<boolean> {
  const updated = await tx
    .update(members)
    .set({ removedAt: new Date() })
    .where(
      and(
        eq(members.id, memberId),
        eq(members.groupId, groupId),
        isNull(members.removedAt),
        eq(members.isOwner, false),
        ne(members.id, caller.memberId),
        ownedByCaller(groupId, caller.userId),
      ),
    )
    .returning();

  return updated.length > 0;
}
