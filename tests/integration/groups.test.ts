import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeTestDatabase, useTestDatabase } from '../helpers/pglite';
import { TestCookieStore, captureRedirect, form, withRequest } from '../helpers/request';
import type { Database } from '@/db/client';
import { activity, groups, members, sessions, users } from '@/db/schema';
import { archiveGroup, createGroup, renameGroup } from '@/app/actions/groups';
import { listGroupsForUser, readGroup, readMembers, readRecentActivity } from '@/lib/access';
import { SESSION_COOKIE, hashPassword, hashToken, newSessionToken } from '@/lib/auth';
import GroupPage from '@/app/(app)/groups/[id]/page';

/**
 * A switch the atomicity cases flip. `recordActivity` is the last write of every mutation, so
 * making it throw is how "the change and its feed entry are one unit" is asserted from outside
 * rather than by reading the transaction body and agreeing with it.
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
  // Hashed once and reused: scrypt at N=2^17 is ~360 ms, and these flows never verify a
  // password — the session cookie is seeded directly. tests/integration/auth.test.ts is where
  // hashing and verification are exercised.
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

/**
 * A signed-in account with a real session row, and a cookie jar holding its token.
 *
 * The row is what makes this a session rather than a mock: resolveSession finds it by the same
 * digest the action path computes.
 */
async function seedUser(email: string, displayName = 'A Person', defaultCurrency = 'EUR') {
  const id = randomUUID();
  await db.insert(users).values({ id, email, passwordHash, displayName, defaultCurrency });

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

async function createAs(cookies: TestCookieStore, values: Record<string, string>) {
  return await withRequest(cookies, () => createGroup(null, form(values)));
}

/**
 * Creates a group owned by `cookies`, returning its id. Fails loudly if the action refused.
 *
 * The currency is passed explicitly and defaults to EUR; an empty string is the form's "use my
 * setting", which is the branch the fallback case exercises.
 */
async function newGroup(cookies: TestCookieStore, name = 'Lisbon', currency = 'EUR'): Promise<string> {
  const result = await createAs(cookies, { name, currency, type: 'trip' });
  if (!result.ok || !result.groupId) throw new Error(`createGroup refused: ${JSON.stringify(result)}`);
  return result.groupId;
}

async function activityKindsFor(groupId: string): Promise<string[]> {
  const rows = await db
    .select({ kind: activity.kind })
    .from(activity)
    .where(eq(activity.groupId, groupId))
    .orderBy(activity.createdAt);
  return rows.map((row) => row.kind);
}

/** Runs `body` and reports whether the page reached notFound() rather than rendering. */
async function captureNotFound(body: () => Promise<unknown>): Promise<boolean> {
  try {
    await body();
    return false;
  } catch (error) {
    if (error instanceof Error && error.message === 'NEXT_NOT_FOUND') return true;
    throw error;
  }
}

describe('creating a group', () => {
  it('writes the group and exactly one is_owner member row, and the returned id resolves', async () => {
    const owner = await seedUser('owner@example.invalid', 'Priya');
    const groupId = await newGroup(owner.cookies);

    const [row] = await db.select().from(groups).where(eq(groups.id, groupId));
    expect(row?.name).toBe('Lisbon');
    expect(row?.currency).toBe('EUR');
    expect(row?.type).toBe('trip');
    expect(row?.archivedAt).toBeNull();
    // Unpredictable and URL-safe: 32 random bytes, base64url.
    expect(row?.inviteToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const memberRows = await db.select().from(members).where(eq(members.groupId, groupId));
    expect(memberRows).toHaveLength(1);
    expect(memberRows[0]).toMatchObject({ userId: owner.id, isOwner: true, removedAt: null });

    // "the returned id resolves": the id the action handed the client is one the overview will
    // actually render, which is what the client's push relies on.
    expect(await readGroup(db, groupId, owner.id)).not.toBeNull();
  }, 60_000);

  it('writes exactly one group.created entry, and nothing else', async () => {
    const owner = await seedUser('feed@example.invalid');
    const groupId = await newGroup(owner.cookies);

    expect(await activityKindsFor(groupId)).toEqual(['group.created']);

    const [entry] = await db.select().from(activity).where(eq(activity.groupId, groupId));
    expect(entry?.actorId).toBe(owner.id);
    expect(entry?.memberId).toBeNull();
  }, 60_000);

  it('trims the name, refuses a whitespace-only or over-long one, and accepts exactly 80 characters', async () => {
    const owner = await seedUser('named@example.invalid');

    const trimmed = await createAs(owner.cookies, { name: '  Lisbon  ', currency: 'EUR', type: 'trip' });
    expect(trimmed.ok).toBe(true);
    const [row] = await db.select().from(groups).where(eq(groups.id, trimmed.groupId ?? ''));
    expect(row?.name).toBe('Lisbon');

    for (const bad of ['   ', '', 'x'.repeat(81)]) {
      const refused = await createAs(owner.cookies, { name: bad, currency: 'EUR' });
      expect(refused.ok).toBe(false);
      expect(refused.fieldErrors?.name).toBeTruthy();
    }

    // The boundary is inclusive: 80 is a name, 81 is not.
    const longest = await createAs(owner.cookies, { name: 'y'.repeat(80), currency: 'EUR' });
    expect(longest.ok).toBe(true);

    expect(await db.select().from(groups)).toHaveLength(2);
  }, 60_000);

  it('falls back to the caller’s default currency, and refuses a code that is not three letters', async () => {
    const owner = await seedUser('currency@example.invalid', 'Priya', 'INR');

    // The form submits an empty currency when the field is left alone, and that means "mine".
    const id = await newGroup(owner.cookies, 'Lisbon', '');
    const [row] = await db.select().from(groups).where(eq(groups.id, id));
    expect(row?.currency).toBe('INR');

    const refused = await createAs(owner.cookies, { name: 'Somewhere', currency: 'EURO' });
    expect(refused.ok).toBe(false);
    expect(refused.fieldErrors?.currency).toBeTruthy();
    expect(await db.select().from(groups)).toHaveLength(1);
  }, 60_000);

  it('a failed feed write leaves the groups table empty — the group and its entry are one unit', async () => {
    const owner = await seedUser('atomic@example.invalid');
    feed.fail = true;

    await expect(createAs(owner.cookies, { name: 'Lisbon', currency: 'EUR', type: 'trip' })).rejects.toThrow(
      'the feed write failed',
    );

    expect(await db.select().from(groups)).toHaveLength(0);
    expect(await db.select().from(members)).toHaveLength(0);
    expect(await db.select().from(activity)).toHaveLength(0);
  }, 60_000);
});

describe('who may read a group', () => {
  it('readGroup is scoped: the creator reads it, a stranger gets nothing at all', async () => {
    const owner = await seedUser('owner@example.invalid', 'Priya');
    const stranger = await seedUser('stranger@example.invalid', 'Sam');
    const groupId = await newGroup(owner.cookies);

    const seen = await readGroup(db, groupId, owner.id);
    expect(seen?.name).toBe('Lisbon');

    // Not "a group without members" and not an empty name: nothing, from the join itself.
    expect(await readGroup(db, groupId, stranger.id)).toBeNull();
    expect(await readMembers(db, groupId, stranger.id)).toBeNull();
  }, 60_000);

  it('the overview page 404s for a non-member, redirects to sign-in when signed out, and 404s a non-uuid', async () => {
    const owner = await seedUser('owner@example.invalid');
    const stranger = await seedUser('stranger@example.invalid');
    const groupId = await newGroup(owner.cookies);

    await withRequest(owner.cookies, async () => {
      const page = await GroupPage({ params: Promise.resolve({ id: groupId }) });
      expect(page).toBeTruthy();
    });

    // A signed-in stranger and a signed-out visitor must not be able to tell the group exists:
    // one gets the 404, the other the sign-in page. Neither gets the name.
    await expect(
      captureNotFound(() => withRequest(stranger.cookies, () => GroupPage({ params: Promise.resolve({ id: groupId }) }))),
    ).resolves.toBe(true);

    await captureRedirect(() =>
      withRequest(new TestCookieStore(), () => GroupPage({ params: Promise.resolve({ id: groupId }) })),
    ).then((target) => expect(target).toBe('/sign-in'));

    // A malformed id is the same 404 rather than a malformed-uuid error from Postgres.
    await expect(
      captureNotFound(() =>
        withRequest(owner.cookies, () => GroupPage({ params: Promise.resolve({ id: 'not-a-uuid' }) })),
      ),
    ).resolves.toBe(true);
  }, 60_000);
});

describe('renaming and archiving', () => {
  it('renames for the owner and leaves the row untouched for a plain member', async () => {
    const owner = await seedUser('owner@example.invalid', 'Priya');
    const groupId = await newGroup(owner.cookies);

    const memberUser = await seedUser('member@example.invalid', 'Sam');
    await db.insert(members).values({ id: randomUUID(), groupId, userId: memberUser.id });

    await withRequest(owner.cookies, () => renameGroup(null, form({ groupId, name: 'Lisbon, April' }))).then(
      (result) => expect(result).toEqual({ ok: true, groupId }),
    );
    const [renamed] = await db.select().from(groups).where(eq(groups.id, groupId));
    expect(renamed?.name).toBe('Lisbon, April');

    const refused = await withRequest(memberUser.cookies, () =>
      renameGroup(null, form({ groupId, name: 'Not mine' })),
    );
    expect(refused.ok).toBe(false);
    expect(refused.formError).toBeTruthy();

    const [after] = await db.select().from(groups).where(eq(groups.id, groupId));
    expect(after?.name).toBe('Lisbon, April');
    expect(await activityKindsFor(groupId)).toEqual(['group.created', 'group.renamed']);
  }, 60_000);

  it('a second signed-in user is refused by both actions, with no data and the rows unchanged', async () => {
    const owner = await seedUser('owner@example.invalid');
    const other = await seedUser('other@example.invalid');
    const groupId = await newGroup(owner.cookies);

    const before = await db.select().from(groups).where(eq(groups.id, groupId));

    for (const attempt of [
      withRequest(other.cookies, () => renameGroup(null, form({ groupId, name: 'Hijacked' }))),
      withRequest(other.cookies, () => archiveGroup(null, form({ groupId }))),
    ]) {
      const result = await attempt;
      expect(result.ok).toBe(false);
      // A refusal names nothing: not the group, not the caller's standing.
      expect(result.groupId).toBeUndefined();
      expect(result.formError).toBeTruthy();
    }

    expect(await db.select().from(groups).where(eq(groups.id, groupId))).toEqual(before);
    expect(await activityKindsFor(groupId)).toEqual(['group.created']);
  }, 60_000);

  it('archiving takes the group out of the list while its URL still renders it', async () => {
    const owner = await seedUser('owner@example.invalid');
    const groupId = await newGroup(owner.cookies);

    expect((await listGroupsForUser(db, owner.id)).map((group) => group.id)).toContain(groupId);

    await withRequest(owner.cookies, () => archiveGroup(null, form({ groupId }))).then((result) =>
      expect(result).toEqual({ ok: true, groupId }),
    );

    expect(await listGroupsForUser(db, owner.id)).toHaveLength(0);
    const readable = await readGroup(db, groupId, owner.id);
    expect(readable?.archivedAt).toBeInstanceOf(Date);
    expect(await activityKindsFor(groupId)).toEqual(['group.created', 'group.archived']);
  }, 60_000);
});

describe('the home list', () => {
  it('excludes other users’ groups, and carries a literal zero balance on every row', async () => {
    const mine = await seedUser('mine@example.invalid');
    const theirs = await seedUser('theirs@example.invalid');

    const mineId = await newGroup(mine.cookies, 'Mine');
    const theirsId = await newGroup(theirs.cookies, 'Theirs');

    const listed = await listGroupsForUser(db, mine.id);
    expect(listed.map((group) => group.id)).toEqual([mineId]);
    expect(listed.map((group) => group.id)).not.toContain(theirsId);

    // The balance is a bigint literal rather than a number: nothing sums to it yet, and a
    // float here would be the wrong type to sum into later.
    expect(listed[0]?.balanceMinor).toBe(0n);
    expect(typeof listed[0]?.balanceMinor).toBe('bigint');
  }, 60_000);

  it('orders by newest activity first, and a group with no activity at all sorts last', async () => {
    const owner = await seedUser('order@example.invalid');
    const [oldest, middle, newest] = [
      await newGroup(owner.cookies, 'Oldest'),
      await newGroup(owner.cookies, 'Middle'),
      await newGroup(owner.cookies, 'Newest'),
    ];

    // Backdated explicitly rather than relying on three transactions landing in the order they
    // were awaited: now() is the transaction's start time, so ties are possible and the test
    // would be asserting the clock rather than the ORDER BY.
    const hoursAgo = (hours: number) => sql`now() - ${`${hours} hours`}::interval`;
    await db.execute(sql`UPDATE activity SET created_at = ${hoursAgo(3)} WHERE group_id = ${oldest}`);
    await db.execute(sql`UPDATE activity SET created_at = ${hoursAgo(2)} WHERE group_id = ${middle}`);
    await db.execute(sql`UPDATE activity SET created_at = ${hoursAgo(1)} WHERE group_id = ${newest}`);

    // A group nothing has ever happened in — the state a NULLS LAST is for. Without it, DESC
    // would float this one to the top of the list, above a group something just happened in.
    const silent = await newGroup(owner.cookies, 'Silent');
    await db.delete(activity).where(eq(activity.groupId, silent));

    expect((await listGroupsForUser(db, owner.id)).map((group) => group.name)).toEqual([
      'Newest',
      'Middle',
      'Oldest',
      'Silent',
    ]);
  }, 60_000);
});

describe('the recent-activity block', () => {
  it('returns only the non-lifecycle entries, newest first, and nothing at all for a non-member', async () => {
    const owner = await seedUser('owner@example.invalid', 'Priya');
    const sam = await seedUser('sam@example.invalid', 'Sam');
    // A signed-in account that is in no way connected to this group. The member below is the
    // reader whose own membership the join has to match, so the two cannot be the same person.
    const outsider = await seedUser('outsider@example.invalid', 'Alex');
    const groupId = await newGroup(owner.cookies);

    const otherMemberId = randomUUID();
    await db.insert(members).values({ id: otherMemberId, groupId, userId: sam.id });

    // The lifecycle entry is already there from creation; add the membership ones on either
    // side of it in time, so excluding group.* is what the ordering has to survive.
    await db.execute(
      sql`UPDATE activity SET created_at = now() - interval '3 hours' WHERE group_id = ${groupId}`,
    );
    const memberEntryId = randomUUID();
    await db.insert(activity).values({
      id: memberEntryId,
      groupId,
      actorId: sam.id,
      memberId: otherMemberId,
      kind: 'member.joined',
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    });
    await db.insert(activity).values({
      groupId,
      actorId: owner.id,
      memberId: otherMemberId,
      kind: 'member.left',
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    const entries = await readRecentActivity(db, groupId, owner.id, 5);
    expect(entries.map((entry) => entry.kind)).toEqual(['member.left', 'member.joined']);
    // The actor's name travels with the entry, so the overview renders a sentence and not an id.
    expect(entries[1]?.actorName).toBe('Sam');
    expect(entries[1]?.id).toBe(memberEntryId);

    // The join is the authorisation: a non-member matches no row and reads nothing. Sam is a
    // member of this group and reads the same two; Alex is not, and reads none.
    expect(await readRecentActivity(db, groupId, sam.id, 5)).toHaveLength(2);
    expect(await readRecentActivity(db, groupId, outsider.id, 5)).toHaveLength(0);
  }, 60_000);

  it('caps the block at the limit it is given', async () => {
    const owner = await seedUser('capped@example.invalid');
    const groupId = await newGroup(owner.cookies);

    // A placeholder rather than a second account for the owner: the partial unique index
    // allows many `user_id is null` rows, where a second row for one user is a violation.
    const otherMemberId = randomUUID();
    await db.insert(members).values({ id: otherMemberId, groupId, userId: null });

    for (let index = 0; index < 7; index += 1) {
      await db.insert(activity).values({
        groupId,
        actorId: owner.id,
        memberId: otherMemberId,
        kind: 'member.joined',
        createdAt: new Date(Date.now() - index * 60_000),
      });
    }

    expect(await readRecentActivity(db, groupId, owner.id, 5)).toHaveLength(5);
  }, 60_000);
});

describe('the members a group reports', () => {
  it('lists the owner first and nobody who has been removed', async () => {
    const owner = await seedUser('owner@example.invalid', 'Priya');
    const groupId = await newGroup(owner.cookies);

    const sam = await seedUser('sam@example.invalid', 'Sam');
    const samMemberId = randomUUID();
    await db.insert(members).values({ id: samMemberId, groupId, userId: sam.id });

    const removedMemberId = randomUUID();
    await db.insert(members).values({
      id: removedMemberId,
      groupId,
      userId: null,
      removedAt: new Date(),
    });

    const rows = await readMembers(db, groupId, owner.id);
    expect(rows?.map((row) => row.displayName)).toEqual(['Priya', 'Sam']);
    expect(rows?.map((row) => row.isOwner)).toEqual([true, false]);
    // A placeholder has no account to take a name from; the row is kept (TR-16) but not listed.
    expect(rows?.some((row) => row.memberId === removedMemberId)).toBe(false);
    expect(await db.select().from(members).where(and(eq(members.groupId, groupId), eq(members.id, removedMemberId)))).toHaveLength(1);
  }, 60_000);
});
