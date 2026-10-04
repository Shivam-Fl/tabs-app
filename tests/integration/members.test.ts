import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeTestDatabase, useTestDatabase } from '../helpers/pglite';
import { TestCookieStore, form, revalidatePath, withRequest } from '../helpers/request';
import type { Database } from '@/db/client';
import { activity, members, sessions, users } from '@/db/schema';
import { createGroup } from '@/app/actions/groups';
import { leaveGroup, removeMember, undoLeave } from '@/app/actions/members';
import { readMembers, readRecentLeave } from '@/lib/access';
import { SESSION_COOKIE, hashPassword, hashToken, newSessionToken } from '@/lib/auth';

/**
 * A switch the atomicity cases flip. See tests/integration/groups.test.ts for why it is a mock
 * of the feed's writer rather than of the transaction: making the LAST write of a mutation
 * throw is what proves the earlier writes in the same body went back with it.
 */
const feed = vi.hoisted(() => ({ fail: false }));

vi.mock('@/lib/activity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/activity')>();
  return {
    ...actual,
    recordActivity: async (tx: Parameters<typeof actual.recordActivity>[0], entry: Parameters<typeof actual.recordActivity>[1]) => {
      if (feed.fail) throw new Error('the feed write failed');
      return actual.recordActivity(tx, entry);
    },
  };
});

let db: Database;
let passwordHash: string;

beforeAll(async () => {
  // Once, and reused: see tests/integration/groups.test.ts for the reasoning.
  passwordHash = await hashPassword('correct horse battery staple');
});

beforeEach(async () => {
  feed.fail = false;
  db = await useTestDatabase();
});

afterAll(async () => {
  vi.restoreAllMocks();
  await closeTestDatabase();
});

async function seedUser(email: string, displayName: string) {
  const id = randomUUID();
  await db.insert(users).values({ id, email, passwordHash, displayName, defaultCurrency: 'EUR' });

  const token = newSessionToken();
  await db.insert(sessions).values({
    userId: id,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });

  const cookies = new TestCookieStore();
  cookies.seed(SESSION_COOKIE, token);
  return { id, cookies };
}

/** A group with its owner, plus a second member with an account of their own. */
async function groupWithTwo() {
  const owner = await seedUser('owner@example.invalid', 'Priya');
  const sam = await seedUser('sam@example.invalid', 'Sam');

  const created = await withRequest(owner.cookies, () =>
    createGroup(null, form({ name: 'Lisbon', currency: 'EUR', type: 'trip' })),
  );
  if (!created.ok || !created.groupId) throw new Error(`createGroup refused: ${JSON.stringify(created)}`);
  const groupId = created.groupId;

  // The owner's row already exists — createGroup wrote it — so it is read back rather than
  // inserted again, which the active-membership index would refuse.
  const [ownerRow] = await db.select().from(members).where(eq(members.groupId, groupId));

  const samMemberId = randomUUID();
  await db.insert(members).values({ id: samMemberId, groupId, userId: sam.id });

  return { owner, sam, groupId, ownerMemberId: ownerRow?.id ?? '', samMemberId };
}

/** The one membership row for a member id — the row itself, removed or not (TR-16). */
async function memberRow(memberId: string) {
  const [row] = await db.select().from(members).where(eq(members.id, memberId));
  return row;
}

/**
 * When the row was removed, or null while it is still active.
 *
 * Stated as a kind rather than compared against a `new Date()` in the test: `now()` is the
 * transaction's start time, so the two differ by the milliseconds the round trip took and an
 * equality assertion would be asserting the clock rather than the write.
 */
async function removalOf(memberId: string): Promise<Date | null> {
  return (await memberRow(memberId))?.removedAt ?? null;
}

/**
 * Asserts that `run` is refused by a specific unique index.
 *
 * The driver puts the constraint on the error's `cause`, and drizzle's own message is the failed
 * SQL. Matching the constraint by name and not just "it threw" is the point: it says WHICH rule
 * refused the write, so a test cannot pass because some other statement failed.
 */
async function expectUniqueViolation(run: () => Promise<unknown>, constraint: string): Promise<void> {
  const failure = await run().then(
    () => null,
    (error: unknown) => error as { cause?: { constraint?: string } },
  );
  expect(failure).not.toBeNull();
  expect(failure?.cause?.constraint).toBe(constraint);
}

async function activityKindsFor(groupId: string): Promise<string[]> {
  const rows = await db
    .select({ kind: activity.kind })
    .from(activity)
    .where(eq(activity.groupId, groupId))
    .orderBy(activity.createdAt, activity.id);
  return rows.map((row) => row.kind);
}

describe('leaving', () => {
  it('writes exactly one member.left with the caller as its actor, and keeps the row', async () => {
    const { sam, groupId, samMemberId } = await groupWithTwo();

    const result = await withRequest(sam.cookies, () => leaveGroup(null, form({ groupId })));
    expect(result).toEqual({ ok: true, groupId });

    expect(await activityKindsFor(groupId)).toEqual(['group.created', 'member.left']);
    const [entry] = await db.select().from(activity).where(eq(activity.kind, 'member.left'));
    expect(entry?.actorId).toBe(sam.id);
    // The entry points at the membership row, which is what undo is authorised against.
    expect(entry?.memberId).toBe(samMemberId);

    // Ended, not deleted: the row is still there with removed_at set.
    expect(await memberRow(samMemberId)).toMatchObject({ userId: sam.id });
    expect(await removalOf(samMemberId)).toBeInstanceOf(Date);
    expect(await db.select().from(members).where(eq(members.groupId, groupId))).toHaveLength(2);

    const listed = await readMembers(db, groupId, sam.id);
    // A non-member gets nothing at all from the group's reads.
    expect(listed).toBeNull();
  }, 60_000);

  it('refuses the owner, with the message that tells them what to do instead, and changes nothing', async () => {
    const { owner, groupId } = await groupWithTwo();
    const before = await db.select().from(members).where(eq(members.groupId, groupId));

    const result = await withRequest(owner.cookies, () => leaveGroup(null, form({ groupId })));

    expect(result.ok).toBe(false);
    expect(result.formError).toMatch(/archive it/i);
    expect(await db.select().from(members).where(eq(members.groupId, groupId))).toEqual(before);
    expect(await activityKindsFor(groupId)).toEqual(['group.created']);
  }, 60_000);
});

describe('undoing a leave', () => {
  it('restores the membership and writes exactly one member.joined', async () => {
    const { sam, groupId, samMemberId } = await groupWithTwo();
    await withRequest(sam.cookies, () => leaveGroup(null, form({ groupId })));

    const result = await withRequest(sam.cookies, () => undoLeave(null, form({ groupId })));
    expect(result).toEqual({ ok: true, groupId });

    expect(await removalOf(samMemberId)).toBeNull();
    expect(await activityKindsFor(groupId)).toEqual(['group.created', 'member.left', 'member.joined']);

    const [joined] = await db.select().from(activity).where(eq(activity.kind, 'member.joined'));
    expect(joined?.actorId).toBe(sam.id);
    expect(joined?.memberId).toBe(samMemberId);

    const listed = await readMembers(db, groupId, sam.id);
    expect(listed?.map((row) => row.displayName)).toEqual(['Priya', 'Sam']);
  }, 60_000);

  it('undoes nothing when the person already has another active membership in the group', async () => {
    const { sam, groupId, samMemberId } = await groupWithTwo();
    await withRequest(sam.cookies, () => leaveGroup(null, form({ groupId })));

    // They were re-added by another route, so there is nothing to restore — and restoring the
    // old row anyway would be the second active row the partial unique index forbids.
    const readdedMemberId = randomUUID();
    await db.insert(members).values({ id: readdedMemberId, groupId, userId: sam.id });

    const result = await withRequest(sam.cookies, () => undoLeave(null, form({ groupId })));

    expect(result.ok).toBe(false);
    expect(result.formError).toBeTruthy();
    expect(await removalOf(samMemberId)).toBeInstanceOf(Date);
    expect(await removalOf(readdedMemberId)).toBeNull();
    expect(await activityKindsFor(groupId)).toEqual(['group.created', 'member.left']);
  }, 60_000);

  it('undoes nothing after the owner removed them, and writes no entry', async () => {
    const { owner, sam, groupId, samMemberId } = await groupWithTwo();

    // The owner removes an ACTIVE member. A row that is already removed is not removable —
    // removeMemberAsOwner requires removed_at to be null — so this is the only shape in which
    // a member.removed can be the last thing to happen to somebody's membership.
    await withRequest(owner.cookies, () => removeMember(null, form({ groupId, memberId: samMemberId })));

    const result = await withRequest(sam.cookies, () => undoLeave(null, form({ groupId })));

    expect(result.ok).toBe(false);
    expect(result.formError).toBeTruthy();
    expect(await removalOf(samMemberId)).toBeInstanceOf(Date);
    expect(await activityKindsFor(groupId)).toEqual(['group.created', 'member.removed']);
  }, 60_000);

  it('is refused after a leave, an undo, and then an owner removal the undo cannot replay over', async () => {
    const { owner, sam, groupId, samMemberId } = await groupWithTwo();
    await withRequest(sam.cookies, () => leaveGroup(null, form({ groupId })));
    await withRequest(sam.cookies, () => undoLeave(null, form({ groupId })));

    // The last thing to happen to this membership is now the owner's decision, so the older
    // member.left is no longer what authorises restoring it — and the refusal leaves the row
    // removed rather than resurrecting it.
    await withRequest(owner.cookies, () => removeMember(null, form({ groupId, memberId: samMemberId })));
    const refused = await withRequest(sam.cookies, () => undoLeave(null, form({ groupId })));

    expect(refused.ok).toBe(false);
    expect(await removalOf(samMemberId)).toBeInstanceOf(Date);
    expect(await activityKindsFor(groupId)).toEqual([
      'group.created',
      'member.left',
      'member.joined',
      'member.removed',
    ]);
  }, 60_000);
});

describe('removing somebody else', () => {
  it('does not revalidate, which is what lets the members screen confirm the removal in place', async () => {
    const { owner, sam, groupId } = await groupWithTwo();
    // A third member, because the control below leaves Sam: removal is refused for a membership
    // whose removed_at is already set, so the same row cannot serve both halves of this test.
    const jo = await seedUser('jo@example.invalid', 'Jo');
    const joMemberId = randomUUID();
    await db.insert(members).values({ id: joMemberId, groupId, userId: jo.id });
    // Creating the group above revalidated once of its own; the control counts from here.
    revalidatePath.mockClear();

    // The control first: a sibling action the same screen drives still revalidates, so a spy that
    // has seen nothing after the removal below is a spy that works rather than one wired to
    // nothing.
    const left = await withRequest(sam.cookies, () => leaveGroup(null, form({ groupId })));
    expect(left).toEqual({ ok: true, groupId });
    expect(revalidatePath).toHaveBeenCalledTimes(1);
    revalidatePath.mockClear();

    const result = await withRequest(owner.cookies, () =>
      removeMember(null, form({ groupId, memberId: joMemberId })),
    );

    expect(result).toEqual({ ok: true, groupId });
    expect(revalidatePath).not.toHaveBeenCalled();
  }, 60_000);

  it('ends the membership by setting removed_at, owner-only, and writes one member.removed', async () => {
    const { owner, sam, groupId, samMemberId } = await groupWithTwo();

    const result = await withRequest(owner.cookies, () =>
      removeMember(null, form({ groupId, memberId: samMemberId })),
    );
    expect(result).toEqual({ ok: true, groupId });

    expect(await memberRow(samMemberId)).toMatchObject({ userId: sam.id });
    expect(await removalOf(samMemberId)).toBeInstanceOf(Date);
    expect(await db.select().from(members).where(eq(members.groupId, groupId))).toHaveLength(2);

    const [entry] = await db.select().from(activity).where(eq(activity.kind, 'member.removed'));
    expect(entry?.actorId).toBe(owner.id);
    expect(entry?.memberId).toBe(samMemberId);

    const listed = await readMembers(db, groupId, owner.id);
    expect(listed?.map((row) => row.displayName)).toEqual(['Priya']);
  }, 60_000);

  it('refuses a plain member, and leaves the row untouched', async () => {
    const { sam, groupId, samMemberId } = await groupWithTwo();

    // Sam has no standing to remove anybody, including themselves by this route.
    const refused = await withRequest(sam.cookies, () =>
      removeMember(null, form({ groupId, memberId: samMemberId })),
    );
    expect(refused.ok).toBe(false);
    expect(refused.formError).toBeTruthy();
    expect(await removalOf(samMemberId)).toBeNull();
    expect(await memberRow(samMemberId)).toMatchObject({ userId: sam.id });
    expect(await db.select().from(activity).where(eq(activity.kind, 'member.removed'))).toHaveLength(0);
  }, 60_000);

  it('refuses the owner’s own membership row, so a group is never left without an owner', async () => {
    const { owner, groupId } = await groupWithTwo();
    const [ownerRow] = await db
      .select()
      .from(members)
      .where(and(eq(members.groupId, groupId), eq(members.isOwner, true)));

    const result = await withRequest(owner.cookies, () =>
      removeMember(null, form({ groupId, memberId: ownerRow?.id ?? '' })),
    );

    expect(result.ok).toBe(false);
    expect(result.formError).toBeTruthy();
    expect(await memberRow(ownerRow?.id ?? '')).toMatchObject({ isOwner: true });
    expect(await removalOf(ownerRow?.id ?? '')).toBeNull();
    expect(await activityKindsFor(groupId)).toEqual(['group.created']);
  }, 60_000);
});

describe('the membership constraints', () => {
  it('rejects a second active membership, allows rejoining after removal, and allows placeholders', async () => {
    const { sam, groupId, samMemberId } = await groupWithTwo();

    // Active duplicate: one person, one group, one active row.
    await expectUniqueViolation(
      () => db.insert(members).values({ id: randomUUID(), groupId, userId: sam.id }),
      'members_group_user_active_idx',
    );

    // Rejoining after a removal is a NEW row, which the predicate's `removed_at is null`
    // clause is what allows: without it, a person could never come back.
    await withRequest(sam.cookies, () => leaveGroup(null, form({ groupId })));
    await db.insert(members).values({ id: randomUUID(), groupId, userId: sam.id });
    expect(
      await db.select().from(members).where(and(eq(members.groupId, groupId), eq(members.userId, sam.id))),
    ).toHaveLength(2);

    // Placeholders have no account, so two of them in one group are not a duplicate.
    await db.insert(members).values({ id: randomUUID(), groupId, userId: null });
    await db.insert(members).values({ id: randomUUID(), groupId, userId: null });
    expect(
      await db.select().from(members).where(and(eq(members.groupId, groupId), isNull(members.userId))),
    ).toHaveLength(2);

    expect(await memberRow(samMemberId)).toBeTruthy();
  }, 60_000);

  it('rejects a second owner and accepts a second plain member', async () => {
    const { groupId, samMemberId } = await groupWithTwo();
    const second = await seedUser('second@example.invalid', 'Alex');

    // One owner per group, as a database constraint rather than a convention.
    await expectUniqueViolation(
      () => db.insert(members).values({ id: randomUUID(), groupId, userId: second.id, isOwner: true }),
      'members_group_owner_idx',
    );

    await db.insert(members).values({ id: randomUUID(), groupId, userId: second.id });
    expect(await db.select().from(members).where(eq(members.groupId, groupId))).toHaveLength(3);
    expect(await memberRow(samMemberId)).toMatchObject({ isOwner: false });
  }, 60_000);
});

describe('a failed feed write', () => {
  it('leaves the membership unchanged for a leave, a removal and an undo', async () => {
    const { owner, sam, groupId, samMemberId } = await groupWithTwo();

    feed.fail = true;
    await expect(
      withRequest(sam.cookies, () => leaveGroup(null, form({ groupId }))),
    ).rejects.toThrow('the feed write failed');
    // The membership row went back with the entry that failed: still active, and not removed.
    expect(await removalOf(samMemberId)).toBeNull();
    expect(await db.select().from(activity).where(eq(activity.kind, 'member.left'))).toHaveLength(0);

    await expect(
      withRequest(owner.cookies, () => removeMember(null, form({ groupId, memberId: samMemberId }))),
    ).rejects.toThrow('the feed write failed');
    expect(await removalOf(samMemberId)).toBeNull();

    feed.fail = false;
    await withRequest(sam.cookies, () => leaveGroup(null, form({ groupId })));

    feed.fail = true;
    await expect(
      withRequest(sam.cookies, () => undoLeave(null, form({ groupId }))),
    ).rejects.toThrow('the feed write failed');
    // The restore rolled back too: the row is still removed, not silently active without the
    // member.joined that would explain it.
    expect(await removalOf(samMemberId)).toBeInstanceOf(Date);
    expect(await activityKindsFor(groupId)).toEqual(['group.created', 'member.left']);
  }, 60_000);
});

describe('a caller who is not in the group', () => {
  it('is refused by leaveGroup, undoLeave and removeMember, with no data and the rows unchanged', async () => {
    const { groupId, samMemberId } = await groupWithTwo();
    const outsider = await seedUser('outsider@example.invalid', 'Alex');
    const before = await db.select().from(members).where(eq(members.groupId, groupId));

    for (const attempt of [
      withRequest(outsider.cookies, () => leaveGroup(null, form({ groupId }))),
      withRequest(outsider.cookies, () => undoLeave(null, form({ groupId }))),
      withRequest(outsider.cookies, () => removeMember(null, form({ groupId, memberId: samMemberId }))),
    ]) {
      const result = await attempt;
      expect(result.ok).toBe(false);
      // A refusal names nothing: not the group, not the member, not the caller's standing.
      expect(result.groupId).toBeUndefined();
      expect(result.formError).toBeTruthy();
    }

    expect(await db.select().from(members).where(eq(members.groupId, groupId))).toEqual(before);
    expect(await activityKindsFor(groupId)).toEqual(['group.created']);
  }, 60_000);
});

describe('the leave notice', () => {
  it('resolves the group’s name for the leaver and for nobody else', async () => {
    const { owner, sam, groupId } = await groupWithTwo();
    await withRequest(sam.cookies, () => leaveGroup(null, form({ groupId })));

    expect(await readRecentLeave(db, sam.id, groupId)).toBe('Lisbon');
    // The owner has no removed membership here, so there is no name for them; and the row is
    // never resolved from the URL alone.
    expect(await readRecentLeave(db, owner.id, groupId)).toBeNull();

    await withRequest(sam.cookies, () => undoLeave(null, form({ groupId })));
    expect(await readRecentLeave(db, sam.id, groupId)).toBeNull();
  }, 60_000);

  it('yields nothing once the leave is older than the notice window', async () => {
    const { sam, groupId } = await groupWithTwo();
    await withRequest(sam.cookies, () => leaveGroup(null, form({ groupId })));

    expect(await readRecentLeave(db, sam.id, groupId)).toBe('Lisbon');

    // A reload, a second tab or the back button must not resurrect the row: the window is what
    // closes it, not the page deciding not to ask.
    await db.execute(
      sql`UPDATE activity SET created_at = now() - interval '11 seconds' WHERE kind = 'member.left'`,
    );
    expect(await readRecentLeave(db, sam.id, groupId)).toBeNull();
  }, 60_000);
});
