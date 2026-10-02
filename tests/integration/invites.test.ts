import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeTestDatabase, useTestDatabase } from '../helpers/pglite';
import { TestCookieStore, captureRedirect, form, withRequest } from '../helpers/request';
import type { Database } from '@/db/client';
import { activity, groups, members, sessions, users } from '@/db/schema';
import type { ActivityKind } from '@/db/schema';
import { signIn, signUp } from '@/app/actions/auth';
import { createGroup } from '@/app/actions/groups';
import {
  addPlaceholderMember,
  claimPlaceholder,
  joinWithToken,
  removeMember,
  rotateInviteLink,
  setInviteEnabled,
} from '@/app/actions/members';
import { readInviteForMember, readMembers, resolveGroupByToken } from '@/lib/access';
import { SESSION_COOKIE, hashPassword, hashToken, newSessionToken } from '@/lib/auth';
import JoinPage from '@/app/join/[token]/page';

/**
 * Invite links, placeholders and claims, asserted against the database.
 *
 * The concurrency cases here run against PGlite, which serialises transactions on its single
 * connection — so they prove the ORDERING the merge depends on (end the caller's row, then let
 * one guarded UPDATE arbitrate) rather than true parallel interleaving. That is the residual
 * risk the work order names, and it is why the loser's path is asserted by its OUTCOME (one
 * winner, a loser who still has their own row and their own sentence) rather than by pretending
 * this is Neon.
 */

/** The feed switch, as in members.test.ts: the last write fails, so the earlier ones go back. */
const feed = vi.hoisted(() => ({ fail: false }));

vi.mock('@/lib/activity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/activity')>();
  return {
    ...actual,
    recordActivity: async (
      tx: Parameters<typeof actual.recordActivity>[0],
      entry: Parameters<typeof actual.recordActivity>[1],
    ) => {
      if (feed.fail) throw new Error('the feed write failed');
      return actual.recordActivity(tx, entry);
    },
  };
});

let db: Database;
let passwordHash: string;

beforeAll(async () => {
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
  return { id, email, cookies };
}

/** A group with its owner, and the group's live invite token. Nobody else is in it yet. */
async function groupWithOwner(name = 'Lisbon') {
  const owner = await seedUser('owner@example.invalid', 'Priya');
  const created = await withRequest(owner.cookies, () =>
    createGroup(null, form({ name, currency: 'EUR', type: 'trip' })),
  );
  if (!created.ok || !created.groupId) throw new Error(`createGroup refused: ${JSON.stringify(created)}`);

  const groupId = created.groupId;
  const [group] = await db.select().from(groups).where(eq(groups.id, groupId));
  const [ownerRow] = await db
    .select()
    .from(members)
    .where(and(eq(members.groupId, groupId), eq(members.isOwner, true)));

  return { owner, groupId, token: group?.inviteToken ?? '', ownerMemberId: ownerRow?.id ?? '' };
}

/** The active memberships of a group — the rows a screen would list. */
async function activeMembers(groupId: string) {
  return db
    .select()
    .from(members)
    .where(and(eq(members.groupId, groupId), isNull(members.removedAt)));
}

async function rowsFor(groupId: string, userId: string) {
  return db
    .select()
    .from(members)
    .where(and(eq(members.groupId, groupId), eq(members.userId, userId)));
}

async function entriesOfKind(groupId: string, kind: ActivityKind) {
  return db
    .select()
    .from(activity)
    .where(and(eq(activity.groupId, groupId), eq(activity.kind, kind)));
}

/** The token of the group whose id this is — read straight from the row the write touched. */
async function tokenOf(groupId: string): Promise<string> {
  const [group] = await db.select({ token: groups.inviteToken }).from(groups).where(eq(groups.id, groupId));
  return group?.token ?? '';
}

async function join(cookies: TestCookieStore, token: string) {
  return withRequest(cookies, () => joinWithToken(null, form({ token })));
}

/** The join page's own render, called the way Next calls it. */
function renderJoinPage(token: string) {
  return JoinPage({ params: Promise.resolve({ token }) });
}

describe('opening an invite link', () => {
  it('is a read: it renders the confirm and writes nothing at all', async () => {
    const { groupId, token, ownerMemberId } = await groupWithOwner();
    const alex = await seedUser('alex@example.invalid', 'Alex');

    // Signed in, not a member, and looking at the page: no row, and no entry. This is the
    // assertion behind not putting a write on the GET — a prefetch, a chat client's unfurl or a
    // second tab must all be able to fetch this URL without joining anybody.
    const page = await withRequest(alex.cookies, () => renderJoinPage(token));

    expect(page).toBeTruthy();
    expect((await activeMembers(groupId)).map((row) => row.id)).toEqual([ownerMemberId]);
    expect(await entriesOfKind(groupId, 'member.joined')).toHaveLength(0);
  }, 60_000);

  it('sends a signed-out visitor to sign-in carrying the destination', async () => {
    const { token } = await groupWithOwner();

    const target = await captureRedirect(() =>
      withRequest(new TestCookieStore(), () => renderJoinPage(token)),
    );

    // Encoded, because it is a query-string value: the path survives, and what the sign-in page
    // hands back is the same destination the link named.
    expect(target).toBe(`/sign-in?next=${encodeURIComponent(`/join/${token}`)}`);
  }, 60_000);

  it('404s a malformed token before the session is even consulted', async () => {
    // No session, and a token that cannot be one: the shape is refused before the redirect, so
    // the answer is a 404 rather than a trip through sign-in for a URL that could never work.
    for (const bad of ['has spaces', 'dots.are.not.in.a.token', '%2Fetc%2Fpasswd', '']) {
      await expect(withRequest(new TestCookieStore(), () => renderJoinPage(bad))).rejects.toThrow('NEXT_NOT_FOUND');
    }
  }, 60_000);

  it('404s a well-formed token that resolves to nothing, for a signed-in caller', async () => {
    const { owner } = await groupWithOwner();
    const alex = await seedUser('alex@example.invalid', 'Alex');

    await expect(
      withRequest(alex.cookies, () => renderJoinPage('this-token-was-never-issued')),
    ).rejects.toThrow('NEXT_NOT_FOUND');
    expect(owner.id).toBeTruthy();
  }, 60_000);
});

describe('joining through a link', () => {
  it('adds exactly one membership and one entry naming the joiner', async () => {
    const { groupId, token } = await groupWithOwner();
    const alex = await seedUser('alex@example.invalid', 'Alex');

    const result = await join(alex.cookies, token);
    expect(result).toEqual({ ok: true, groupId });

    const active = await activeMembers(groupId);
    expect(active).toHaveLength(2);
    const joined = active.find((row) => row.userId === alex.id);
    expect(joined).toBeTruthy();

    const [entry] = await entriesOfKind(groupId, 'member.joined');
    expect(entry?.actorId).toBe(alex.id);
    expect(entry?.memberId).toBe(joined?.id);
  }, 60_000);

  it('is a no-op the second time, with no second row and no second entry', async () => {
    const { groupId, token } = await groupWithOwner();
    const alex = await seedUser('alex@example.invalid', 'Alex');

    expect((await join(alex.cookies, token)).ok).toBe(true);
    // The same link, confirmed again — a back button, a double click, or a second tab.
    expect((await join(alex.cookies, token)).ok).toBe(true);

    expect(await activeMembers(groupId)).toHaveLength(2);
    expect(await entriesOfKind(groupId, 'member.joined')).toHaveLength(1);
  }, 60_000);

  it('yields one membership when two confirms race each other', async () => {
    const { groupId, token } = await groupWithOwner();
    const alex = await seedUser('alex@example.invalid', 'Alex');

    const [first, second] = await Promise.all([join(alex.cookies, token), join(alex.cookies, token)]);

    // Both answer ok — the loser is not an error, it is the same answer to the same request —
    // and the group has one membership for one person.
    expect([first.ok, second.ok]).toEqual([true, true]);
    expect(await activeMembers(groupId)).toHaveLength(2);
    expect(await entriesOfKind(groupId, 'member.joined')).toHaveLength(1);
    expect(await rowsFor(groupId, alex.id)).toHaveLength(1);
  }, 60_000);

  it('refuses a stale confirm after the link was rotated, without throwing', async () => {
    const { owner, groupId, token: oldToken } = await groupWithOwner();
    const alex = await seedUser('alex@example.invalid', 'Alex');

    await withRequest(owner.cookies, () => rotateInviteLink(null, form({ groupId })));

    // The page was rendered from a token that was live at the time; the POST arrives after the
    // owner replaced it. A sentence, not a 500 — and no row.
    const result = await join(alex.cookies, oldToken);
    expect(result.ok).toBe(false);
    expect(result.formError).toBeTruthy();
    expect(await rowsFor(groupId, alex.id)).toHaveLength(0);
  }, 60_000);

  it('refuses a token whose link has been turned off, and a malformed one', async () => {
    const { owner, groupId, token } = await groupWithOwner();
    const alex = await seedUser('alex@example.invalid', 'Alex');

    await withRequest(owner.cookies, () => setInviteEnabled(null, form({ groupId, enabled: 'false' })));

    expect((await join(alex.cookies, token)).ok).toBe(false);
    expect((await join(alex.cookies, 'not a token')).ok).toBe(false);
    expect(await rowsFor(groupId, alex.id)).toHaveLength(0);
  }, 60_000);
});

describe('what a token discloses', () => {
  it('resolves to the id and the name and nothing else', async () => {
    const { token } = await groupWithOwner();
    const resolved = await resolveGroupByToken(db, token);

    // The whole read, deliberately: a bearer token buys the group's name and the right to join
    // it. A currency, an owner, a member count or a feed is not something a forwarded link is
    // allowed to tell a stranger.
    expect(resolved?.name).toBe('Lisbon');
    expect(resolved?.id).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    expect(Object.keys(resolved ?? {}).sort()).toEqual(['id', 'name']);
  }, 60_000);

  it('resolves to nothing while the link is off or the group is archived', async () => {
    const { owner, groupId, token } = await groupWithOwner();

    await withRequest(owner.cookies, () => setInviteEnabled(null, form({ groupId, enabled: 'false' })));
    expect(await resolveGroupByToken(db, token)).toBeNull();

    await db.update(groups).set({ archivedAt: new Date(), inviteEnabled: true }).where(eq(groups.id, groupId));
    expect(await resolveGroupByToken(db, token)).toBeNull();
  }, 60_000);

  it('is readable by a member and by nobody else', async () => {
    const { owner, groupId, token } = await groupWithOwner();
    const alex = await seedUser('alex@example.invalid', 'Alex');

    // The member-scoped read: the token is a secret, so it does not travel on GroupRow.
    expect(await readInviteForMember(db, groupId, owner.id)).toEqual({ token, enabled: true });
    expect(await readInviteForMember(db, groupId, alex.id)).toBeNull();
  }, 60_000);
});

describe('placeholders', () => {
  it('adds one by name, and readMembers hands the stored name back as a placeholder', async () => {
    const { owner, groupId } = await groupWithOwner();

    const result = await withRequest(owner.cookies, () =>
      addPlaceholderMember(null, form({ groupId, name: '  Robin  ' })),
    );
    expect(result).toEqual({ ok: true, groupId });

    const listed = await readMembers(db, groupId, owner.id);
    const placeholder = listed?.find((row) => row.isPlaceholder);
    // Trimmed on the way in, so the stored name is what a person would have typed.
    expect(placeholder).toMatchObject({ displayName: 'Robin', isPlaceholder: true, isOwner: false });

    const [entry] = await entriesOfKind(groupId, 'member.placeholder_added');
    expect(entry?.actorId).toBe(owner.id);
    expect(entry?.memberId).toBe(placeholder?.memberId);
  }, 60_000);

  it('refuses a blank and an overlong name, writing neither a row nor an entry', async () => {
    const { owner, groupId } = await groupWithOwner();

    for (const name of ['', '   ', 'x'.repeat(81)]) {
      const result = await withRequest(owner.cookies, () => addPlaceholderMember(null, form({ groupId, name })));
      expect(result.ok).toBe(false);
      expect(result.fieldErrors?.name).toBeTruthy();
    }

    expect(await activeMembers(groupId)).toHaveLength(1);
    expect(await entriesOfKind(groupId, 'member.placeholder_added')).toHaveLength(0);
  }, 60_000);

  it('refuses a plain member, who has no standing to add anybody', async () => {
    const { groupId, token } = await groupWithOwner();
    const alex = await seedUser('alex@example.invalid', 'Alex');
    await join(alex.cookies, token);

    const result = await withRequest(alex.cookies, () =>
      addPlaceholderMember(null, form({ groupId, name: 'Robin' })),
    );

    expect(result.ok).toBe(false);
    expect(result.formError).toBeTruthy();
    expect(await activeMembers(groupId)).toHaveLength(2);
    expect(await entriesOfKind(groupId, 'member.placeholder_added')).toHaveLength(0);
  }, 60_000);
});

describe('claiming a placeholder', () => {
  /** The owner, a member who joined through the link, and a placeholder they may claim. */
  async function claimedReady(placeholderName = 'Sammy') {
    const setup = await groupWithOwner();
    const alex = await seedUser('alex@example.invalid', 'Alex');
    await join(alex.cookies, setup.token);

    const added = await withRequest(setup.owner.cookies, () =>
      addPlaceholderMember(null, form({ groupId: setup.groupId, name: placeholderName })),
    );
    if (!added.ok) throw new Error(`addPlaceholderMember refused: ${JSON.stringify(added)}`);

    const [placeholder] = (await activeMembers(setup.groupId)).filter((row) => row.userId === null);
    const [ownRow] = await rowsFor(setup.groupId, alex.id);

    return { ...setup, alex, placeholderId: placeholder?.id ?? '', ownMemberId: ownRow?.id ?? '' };
  }

  it('merges the claimer into it, leaving exactly one active row that reads as theirs', async () => {
    const { alex, groupId, placeholderId, ownMemberId } = await claimedReady();

    const result = await withRequest(alex.cookies, () =>
      claimPlaceholder(null, form({ groupId, memberId: placeholderId })),
    );
    expect(result).toEqual({ ok: true, groupId });

    // One row, still the placeholder's identity — so every share, payer or expense recorded
    // against it is now the claimer's without a single one of them being rewritten.
    const rows = await rowsFor(groupId, alex.id);
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.removedAt === null).map((row) => row.id)).toEqual([placeholderId]);
    expect(rows.filter((row) => row.id === ownMemberId && row.removedAt !== null)).toHaveLength(1);

    // The live profile name wins over the name the placeholder was created with.
    const listed = await readMembers(db, groupId, alex.id);
    const claimed = listed?.find((row) => row.memberId === placeholderId);
    expect(claimed).toMatchObject({ displayName: 'Alex', isPlaceholder: false });

    const [entry] = await entriesOfKind(groupId, 'member.claimed');
    expect(entry?.actorId).toBe(alex.id);
    expect(entry?.memberId).toBe(placeholderId);
  }, 60_000);

  it('refuses a second claim, with the row and the loser’s own membership untouched', async () => {
    const { alex, groupId, placeholderId } = await claimedReady();
    await withRequest(alex.cookies, () => claimPlaceholder(null, form({ groupId, memberId: placeholderId })));

    // The same person, claiming the same entry again: their active row IS the placeholder now,
    // so there is nothing to merge and the refusal leaves everything where it was.
    const again = await withRequest(alex.cookies, () =>
      claimPlaceholder(null, form({ groupId, memberId: placeholderId })),
    );
    expect(again.ok).toBe(false);
    expect(again.formError).toMatch(/already been claimed/i);

    const rows = await rowsFor(groupId, alex.id);
    expect(rows.filter((row) => row.removedAt === null).map((row) => row.id)).toEqual([placeholderId]);

    // And a second person is told the same thing, keeping the membership they already had.
    const bea = await seedUser('bea@example.invalid', 'Bea');
    await join(bea.cookies, await tokenOf(groupId));
    const refused = await withRequest(bea.cookies, () =>
      claimPlaceholder(null, form({ groupId, memberId: placeholderId })),
    );
    expect(refused.formError).toMatch(/already been claimed/i);

    const [beaRow] = await rowsFor(groupId, bea.id);
    expect(beaRow?.removedAt).toBeNull();
    expect(beaRow?.id).not.toBe(placeholderId);
  }, 60_000);

  it('says a removed placeholder is no longer available, not that it was claimed', async () => {
    const { owner, alex, groupId, placeholderId } = await claimedReady();

    // Removed by the owner through the ordinary control, so the row is ended rather than
    // deleted and the claim has to tell "gone" apart from "taken".
    const removed = await withRequest(owner.cookies, () =>
      removeMember(null, form({ groupId, memberId: placeholderId })),
    );
    expect(removed.ok).toBe(true);

    const result = await withRequest(alex.cookies, () =>
      claimPlaceholder(null, form({ groupId, memberId: placeholderId })),
    );

    expect(result.ok).toBe(false);
    expect(result.formError).toMatch(/no longer in this group/i);
    expect(result.formError).not.toMatch(/already been claimed/i);
    // The caller is exactly as they were: the restore put their own row back.
    const [ownRow] = await rowsFor(groupId, alex.id);
    expect(ownRow?.removedAt).toBeNull();
  }, 60_000);

  it('refuses the owner, because nothing here can promote a new one', async () => {
    const { owner, groupId } = await groupWithOwner();
    await withRequest(owner.cookies, () => addPlaceholderMember(null, form({ groupId, name: 'Robin' })));
    const [placeholder] = (await activeMembers(groupId)).filter((row) => row.userId === null);

    const result = await withRequest(owner.cookies, () =>
      claimPlaceholder(null, form({ groupId, memberId: placeholder?.id ?? '' })),
    );

    expect(result.ok).toBe(false);
    expect(result.formError).toMatch(/own this group/i);
    expect(await entriesOfKind(groupId, 'member.claimed')).toHaveLength(0);

    // The owner's row is untouched and still the group's owner.
    const [ownerRow] = await activeMembers(groupId);
    expect(ownerRow?.isOwner).toBe(true);
  }, 60_000);

  it('refuses somebody who is not in the group at all', async () => {
    const { owner, groupId } = await groupWithOwner();
    await withRequest(owner.cookies, () => addPlaceholderMember(null, form({ groupId, name: 'Robin' })));
    const [placeholder] = (await activeMembers(groupId)).filter((row) => row.userId === null);
    const outsider = await seedUser('outsider@example.invalid', 'Outsider');

    const result = await withRequest(outsider.cookies, () =>
      claimPlaceholder(null, form({ groupId, memberId: placeholder?.id ?? '' })),
    );

    expect(result.ok).toBe(false);
    expect(result.formError).toMatch(/not a member/i);
    expect((await activeMembers(groupId)).filter((row) => row.userId === null)).toHaveLength(1);
  }, 60_000);

  it('gives exactly one of two racing claims the row, and keeps the loser a member', async () => {
    const { token, groupId, placeholderId } = await claimedReady();
    const bea = await seedUser('bea@example.invalid', 'Bea');
    const cal = await seedUser('cal@example.invalid', 'Cal');
    await join(bea.cookies, token);
    await join(cal.cookies, token);

    const [beaResult, calResult] = await Promise.all([
      withRequest(bea.cookies, () => claimPlaceholder(null, form({ groupId, memberId: placeholderId }))),
      withRequest(cal.cookies, () => claimPlaceholder(null, form({ groupId, memberId: placeholderId }))),
    ]);

    const winners = [beaResult, calResult].filter((result) => result.ok);
    const losers = [beaResult, calResult].filter((result) => !result.ok);
    expect(winners).toHaveLength(1);
    // Not an error, a sentence: the loser is told the entry is taken and keeps their own row.
    expect(losers[0]?.formError).toMatch(/already been claimed/i);

    const [winner] = (await activeMembers(groupId)).filter((row) => row.id === placeholderId);
    expect(winner?.userId).toBeTruthy();

    const loserId = winner?.userId === bea.id ? cal.id : bea.id;
    const loserRows = await rowsFor(groupId, loserId);
    expect(loserRows.filter((row) => row.removedAt === null)).toHaveLength(1);
    expect(loserRows.find((row) => row.removedAt === null)?.id).not.toBe(placeholderId);

    // One claim, one entry: the loser's rollback left nothing behind to explain.
    expect(await entriesOfKind(groupId, 'member.claimed')).toHaveLength(1);
  }, 60_000);
});

describe('the invite link’s owner controls', () => {
  it('rotates to a new token that joins, and kills the old one', async () => {
    const { owner, groupId, token: oldToken } = await groupWithOwner();
    const alex = await seedUser('alex@example.invalid', 'Alex');

    const rotated = await withRequest(owner.cookies, () => rotateInviteLink(null, form({ groupId })));
    expect(rotated).toEqual({ ok: true, groupId });

    const newToken = await tokenOf(groupId);
    expect(newToken).not.toBe(oldToken);
    expect(await resolveGroupByToken(db, oldToken)).toBeNull();
    expect(await resolveGroupByToken(db, newToken)).not.toBeNull();

    expect((await join(alex.cookies, oldToken)).ok).toBe(false);
    expect((await join(alex.cookies, newToken)).ok).toBe(true);
    expect(await entriesOfKind(groupId, 'group.invite_rotated')).toHaveLength(1);
  }, 60_000);

  it('refuses a non-owner, leaving the token exactly as it was', async () => {
    const { token, groupId } = await groupWithOwner();
    const alex = await seedUser('alex@example.invalid', 'Alex');
    await join(alex.cookies, token);

    const rotated = await withRequest(alex.cookies, () => rotateInviteLink(null, form({ groupId })));
    const disabled = await withRequest(alex.cookies, () =>
      setInviteEnabled(null, form({ groupId, enabled: 'false' })),
    );

    expect(rotated.ok).toBe(false);
    expect(disabled.ok).toBe(false);
    expect(await tokenOf(groupId)).toBe(token);
    expect(await resolveGroupByToken(db, token)).not.toBeNull();
    expect(await entriesOfKind(groupId, 'group.invite_rotated')).toHaveLength(0);
    expect(await entriesOfKind(groupId, 'group.invite_disabled')).toHaveLength(0);
  }, 60_000);

  it('turns the link off, and makes a new one the way back on', async () => {
    const { owner, groupId, token } = await groupWithOwner();

    const off = await withRequest(owner.cookies, () =>
      setInviteEnabled(null, form({ groupId, enabled: 'false' })),
    );
    expect(off).toEqual({ ok: true, groupId });
    expect(await resolveGroupByToken(db, token)).toBeNull();
    expect(await entriesOfKind(groupId, 'group.invite_disabled')).toHaveLength(1);

    // Re-enabling the retired token is refused: reviving a string somebody may already hold is
    // the opposite of what turning a link off is for. The way back is a new link.
    const revived = await withRequest(owner.cookies, () =>
      setInviteEnabled(null, form({ groupId, enabled: 'true' })),
    );
    expect(revived.ok).toBe(false);
    expect(await resolveGroupByToken(db, token)).toBeNull();

    await withRequest(owner.cookies, () => rotateInviteLink(null, form({ groupId })));
    expect(await resolveGroupByToken(db, await tokenOf(groupId))).not.toBeNull();
  }, 60_000);
});

describe('a failed feed write', () => {
  it('leaves the join, the placeholder, the claim, the rotation and the disable all unmade', async () => {
    const { owner, groupId, token } = await groupWithOwner();
    const alex = await seedUser('alex@example.invalid', 'Alex');

    feed.fail = true;

    await expect(join(alex.cookies, token)).rejects.toThrow('the feed write failed');
    expect(await rowsFor(groupId, alex.id)).toHaveLength(0);

    await expect(
      withRequest(owner.cookies, () => addPlaceholderMember(null, form({ groupId, name: 'Robin' }))),
    ).rejects.toThrow('the feed write failed');
    expect(await activeMembers(groupId)).toHaveLength(1);

    const rotated = await tokenOf(groupId);
    await expect(
      withRequest(owner.cookies, () => rotateInviteLink(null, form({ groupId }))),
    ).rejects.toThrow('the feed write failed');
    expect(await tokenOf(groupId)).toBe(rotated);

    await expect(
      withRequest(owner.cookies, () => setInviteEnabled(null, form({ groupId, enabled: 'false' }))),
    ).rejects.toThrow('the feed write failed');
    expect(await resolveGroupByToken(db, token)).not.toBeNull();

    feed.fail = false;

    // And a claim: the caller's own row is ended and then restored, so a refused feed write
    // leaves them a member rather than a person with no membership and no explanation.
    await join(alex.cookies, token);
    await withRequest(owner.cookies, () => addPlaceholderMember(null, form({ groupId, name: 'Robin' })));
    const [placeholder] = (await activeMembers(groupId)).filter((row) => row.userId === null);

    feed.fail = true;
    await expect(
      withRequest(alex.cookies, () => claimPlaceholder(null, form({ groupId, memberId: placeholder?.id ?? '' }))),
    ).rejects.toThrow('the feed write failed');

    feed.fail = false;
    const [alexRow] = await rowsFor(groupId, alex.id);
    expect(alexRow?.removedAt).toBeNull();
    const [unclaimed] = (await activeMembers(groupId)).filter((row) => row.userId === null);
    expect(unclaimed?.id).toBe(placeholder?.id);
    expect(await entriesOfKind(groupId, 'member.claimed')).toHaveLength(0);
  }, 60_000);
});

describe('the destination carried through sign-in', () => {
  it('is honoured by sign-in and by sign-up', async () => {
    const destination = `/join/${'a'.repeat(43)}`;
    const user = await seedUser('traveler@example.invalid', 'Traveler');

    const signedIn = await withRequest(new TestCookieStore(), () =>
      signIn(null, form({ email: user.email, password: 'correct horse battery staple', next: destination })),
    );
    expect(signedIn).toEqual({ ok: true, redirectTo: destination });

    const signedUp = await withRequest(new TestCookieStore(), () =>
      signUp(null, form({ displayName: 'Newcomer', email: 'newcomer@example.invalid', password: 'correct horse battery staple', next: destination })),
    );
    expect(signedUp).toEqual({ ok: true, redirectTo: destination });
  }, 60_000);

  it('falls back to the home screen for anything that is not a path in this app', async () => {
    const user = await seedUser('traveler@example.invalid', 'Traveler');

    // `//host` and `/\host` are the two that matter: a browser reads both as another origin, so
    // honouring either turns sign-in into an open redirect. The others are simply not paths.
    for (const evil of ['//evil.invalid', '/\\evil.invalid', 'https://evil.invalid', 'join/abc', 'javascript:alert(1)', '']) {
      const result = await withRequest(new TestCookieStore(), () =>
        signIn(null, form({ email: user.email, password: 'correct horse battery staple', next: evil })),
      );
      expect(result).toEqual({ ok: true, redirectTo: '/' });
    }
  }, 60_000);

  it('falls back when no destination was supplied at all', async () => {
    const user = await seedUser('traveler@example.invalid', 'Traveler');

    const result = await withRequest(new TestCookieStore(), () =>
      signIn(null, form({ email: user.email, password: 'correct horse battery staple' })),
    );
    expect(result).toEqual({ ok: true, redirectTo: '/' });
  }, 60_000);
});
