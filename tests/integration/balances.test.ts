import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeTestDatabase, useTestDatabase } from '../helpers/pglite';
import { TestCookieStore, form, withRequest } from '../helpers/request';
import type { Database } from '@/db/client';
import {
  activity,
  expensePayer,
  expenseShare,
  expenseSplitInput,
  expenses,
  members,
  sessions,
  users,
} from '@/db/schema';
import { createExpense } from '@/app/actions/expenses';
import { createGroup } from '@/app/actions/groups';
import { leaveGroup, removeMember } from '@/app/actions/members';
import {
  listGroupsForUser,
  readBalancesForGroup,
  readExpensesForGroup,
  readNetBalanceForMember,
} from '@/lib/access';
import { SETTLE_FIRST_MESSAGE, simplifyDebts, sumBalances, summariseForViewer } from '@/lib/balances';
import { SESSION_COOKIE, hashPassword, hashToken, newSessionToken } from '@/lib/auth';

/**
 * Balances against a real schema on a real (in-process) Postgres, written through the real
 * actions rather than by inserting ledger rows directly: the point of these cases is that the
 * figures a screen shows come out of what the WRITE path stored, so a fixture that hand-built
 * payer and share rows would be testing the fixture.
 *
 * The four things this file exists to prove: a balance is a sum of the stored payer and share
 * rows and never of the stored rule (TR-4), the home totals are the sums of the per-group ones
 * with a removed group absent from both (TR-8), the leave and remove guards refuse inside the
 * transaction they would have written with and write nothing (TR-13), and removing a member
 * keeps every row they were part of (TR-16).
 */
let db: Database;
let passwordHash: string;

beforeAll(async () => {
  // Hashed once and reused: scrypt at N=2^17 is ~360 ms, and no flow here verifies a password.
  passwordHash = await hashPassword('correct horse battery staple');
});

beforeEach(async () => {
  db = await useTestDatabase();
});

afterAll(async () => {
  vi.restoreAllMocks();
  await closeTestDatabase();
});

interface Seeded {
  id: string;
  displayName: string;
  cookies: TestCookieStore;
}

async function seedUser(email: string, displayName: string): Promise<Seeded> {
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
  return { id, displayName, cookies };
}

/** The FormData a browser posts; the repeated fields are the form's contract with the action. */
function expenseForm(values: {
  groupId: string;
  description?: string;
  amount?: string;
  splitType?: string;
  participants?: string[];
  payers?: { memberId: string; amount: string }[];
}): FormData {
  const data = new FormData();
  data.append('groupId', values.groupId);
  data.append('description', values.description ?? 'Dinner');
  data.append('amount', values.amount ?? '10');
  data.append('date', '2026-10-01');
  data.append('category', '');
  data.append('note', '');
  data.append('splitType', values.splitType ?? 'equal');
  for (const memberId of values.participants ?? []) data.append('participant', memberId);
  for (const payer of values.payers ?? []) {
    data.append('payer', payer.memberId);
    data.append(`payerAmount.${payer.memberId}`, payer.amount);
  }
  return data;
}

async function record(cookies: TestCookieStore, values: Parameters<typeof expenseForm>[0]) {
  const result = await withRequest(cookies, () => createExpense(null, expenseForm(values)));
  if (!result.ok) throw new Error(`createExpense refused: ${JSON.stringify(result)}`);
  return result;
}

/**
 * A group owned by `owner`, with two more members added directly.
 *
 * createGroup writes the owner's row, and the canonical member order is owner first, then
 * created_at, then id — so the two members' timestamps are set here rather than left to now().
 * Two rows written in the same instant would fall back to a random uuid and the order these
 * cases assert against would be a coin toss.
 */
async function groupWith(owner: Seeded, name: string, others: Seeded[]) {
  const created = await withRequest(owner.cookies, () =>
    createGroup(null, form({ name, currency: 'EUR', type: 'trip' })),
  );
  if (!created.ok || !created.groupId) throw new Error(`createGroup refused: ${JSON.stringify(created)}`);
  const groupId = created.groupId;

  const [ownerRow] = await db.select().from(members).where(eq(members.groupId, groupId));
  if (!ownerRow) throw new Error('createGroup wrote no owner membership');

  const memberIds = others.map(() => randomUUID());
  if (others.length > 0) {
    await db.insert(members).values(
      others.map((other, index) => ({
        id: memberIds[index],
        groupId,
        userId: other.id,
        createdAt: new Date(`2026-01-0${index + 1}T00:00:00.000Z`),
      })),
    );
  }

  return { groupId, ownerMemberId: ownerRow.id, memberIds };
}

/**
 * Three expenses, one paid by somebody other than the owner and one split between only two of
 * the three members, so the sums cannot come out right by symmetry:
 *
 *   dinner  30.00, paid by Priya, split three ways  → Priya +20.00, Sam −10.00, Dev −10.00
 *   taxi    12.00, paid by Sam,   split two ways    → Sam    +6.00, Priya  −6.00
 *   museum   9.00, paid by Dev,   split three ways  → Dev    +6.00, Priya  −3.00
 *
 *   nets: Priya +11.00, Sam −7.00, Dev −4.00
 */
async function threeWayLedger(owner: Seeded, name = 'Lisbon') {
  const sam = await seedUser(`${name}-sam@example.invalid`, 'Sam');
  const dev = await seedUser(`${name}-dev@example.invalid`, 'Dev');
  const { groupId, ownerMemberId, memberIds } = await groupWith(owner, name, [sam, dev]);
  const samMemberId = memberIds[0];
  const devMemberId = memberIds[1];
  const everyone = [ownerMemberId, samMemberId, devMemberId];

  await record(owner.cookies, {
    groupId,
    description: 'Dinner',
    amount: '30',
    participants: everyone,
    payers: [{ memberId: ownerMemberId, amount: '30' }],
  });
  await record(owner.cookies, {
    groupId,
    description: 'Taxi',
    amount: '12',
    participants: [ownerMemberId, samMemberId],
    payers: [{ memberId: samMemberId, amount: '12' }],
  });
  await record(owner.cookies, {
    groupId,
    description: 'Museum',
    amount: '9',
    participants: everyone,
    payers: [{ memberId: devMemberId, amount: '9' }],
  });

  return { owner, sam, dev, groupId, ownerMemberId, samMemberId, devMemberId };
}

/** Every active member's net in a group, as the screens read it. */
async function nets(groupId: string, viewer: Seeded) {
  const balances = await readBalancesForGroup(db, groupId, viewer.id);
  if (!balances) throw new Error('readBalancesForGroup returned null for a member');
  return balances;
}

function netOf(memberList: { memberId: string; balanceMinor: bigint }[], memberId: string): bigint {
  return memberList.find((member) => member.memberId === memberId)?.balanceMinor ?? 0n;
}

describe('reading a balance out of the stored ledger', () => {
  it('sums the payer and share rows per member, in canonical order', async () => {
    const { owner, groupId, ownerMemberId, samMemberId, devMemberId } = await threeWayLedger(await seedUser('read-owner@example.invalid', 'Priya'));

    const balances = await nets(groupId, owner);

    expect(balances.viewerMemberId).toBe(ownerMemberId);
    expect(balances.members).toEqual([
      { memberId: ownerMemberId, displayName: 'Priya', balanceMinor: 1100n },
      { memberId: samMemberId, displayName: 'Sam', balanceMinor: -700n },
      { memberId: devMemberId, displayName: 'Dev', balanceMinor: -400n },
    ]);
    expect(sumBalances(balances.members)).toBe(0n);
  });

  it('settles those nets in n − 1 transfers, largest debtor first', async () => {
    const { owner, groupId, ownerMemberId, samMemberId, devMemberId } = await threeWayLedger(
      await seedUser('settle-owner@example.invalid', 'Priya'),
    );
    const balances = await nets(groupId, owner);

    expect(simplifyDebts(balances.members)).toEqual([
      { fromMemberId: samMemberId, toMemberId: ownerMemberId, amountMinor: 700n },
      { fromMemberId: devMemberId, toMemberId: ownerMemberId, amountMinor: 400n },
    ]);
  });

  it('moves nothing when the stored split rule is rewritten', async () => {
    const { owner, groupId, samMemberId, devMemberId } = await threeWayLedger(
      await seedUser('rule-owner@example.invalid', 'Priya'),
    );
    const before = await nets(groupId, owner);
    expect(before.members.map((member) => member.balanceMinor)).toEqual([1100n, -700n, -400n]);

    /**
     * TR-4's whole point, asserted against the database rather than by reading the query: the
     * rule an expense was entered with is stored, and changing it — even changing its TYPE —
     * cannot restate what anybody owed. Balances are sums of expense_payer and expense_share,
     * and not one of those rows is touched here.
     */
    await db.update(expenseSplitInput).set({ inputValue: 999999n });
    await db.update(expenses).set({ splitType: 'exact' });

    const after = await nets(groupId, owner);

    expect(after.members).toEqual(before.members);
    expect(simplifyDebts(after.members)).toEqual(simplifyDebts(before.members));

    // The rewrite really happened, so the assertion above is not two reads of an unchanged table.
    const rewritten = await db.select().from(expenses).where(eq(expenses.groupId, groupId));
    expect(rewritten).toHaveLength(3);
    expect(rewritten.map((row) => row.splitType)).toEqual(['exact', 'exact', 'exact']);
    expect(netOf(after.members, samMemberId)).toBe(-700n);
    expect(netOf(after.members, devMemberId)).toBe(-400n);
  });

  it('answers a non-member with nothing rather than with a figure', async () => {
    const { groupId } = await threeWayLedger(await seedUser('auth-owner@example.invalid', 'Priya'));
    const outsider = await seedUser('outsider@example.invalid', 'Outsider');

    expect(await readBalancesForGroup(db, groupId, outsider.id)).toBeNull();
    expect(await readNetBalanceForMember(db, groupId, randomUUID(), outsider.id)).toBeNull();
  });
});

describe('the home screen’s totals', () => {
  it('are the per-group sums, with the breakdowns adding up, and skip a removed group', async () => {
    const owner = await seedUser('home-owner@example.invalid', 'Priya');

    // Lisbon: the three-way ledger. The caller is owed 11.00.
    const lisbon = await threeWayLedger(owner);

    // Porto: the caller is the one who owes, so the summary carries both signs.
    const portoSam = await seedUser('porto-sam@example.invalid', 'Sam');
    const porto = await groupWith(owner, 'Porto', [portoSam]);
    await record(owner.cookies, {
      groupId: porto.groupId,
      amount: '10',
      participants: [porto.ownerMemberId, porto.memberIds[0]],
      payers: [{ memberId: porto.memberIds[0], amount: '10' }],
    });

    // Madrid: the caller is owed, and then their membership is removed at the data level — the
    // state an expense edit after a removal produces. The group must vanish from the list AND
    // from the totals: a total over "the groups that still count" is the lie TR-8 forbids.
    const madridOther = await seedUser('madrid-other@example.invalid', 'Bo');
    const madrid = await groupWith(owner, 'Madrid', [madridOther]);
    await record(owner.cookies, {
      groupId: madrid.groupId,
      amount: '14',
      participants: [madrid.ownerMemberId, madrid.memberIds[0]],
      payers: [{ memberId: madrid.ownerMemberId, amount: '14' }],
    });
    await db.update(members).set({ removedAt: new Date() }).where(eq(members.id, madrid.ownerMemberId));

    const groups = await listGroupsForUser(db, owner.id);
    expect(groups.map((group) => group.name).sort()).toEqual(['Lisbon', 'Porto']);
    expect(groups.find((group) => group.name === 'Lisbon')?.balanceMinor).toBe(1100n);
    expect(groups.find((group) => group.name === 'Porto')?.balanceMinor).toBe(-500n);

    // The summary is built from the same read each group screen makes, one group at a time.
    const loaded = [];
    for (const group of groups) {
      const balances = await readBalancesForGroup(db, group.id, owner.id);
      if (!balances) throw new Error('a group the caller is in read as null');
      expect(sumBalances(balances.members)).toBe(0n);
      loaded.push({
        viewerMemberId: balances.viewerMemberId,
        members: balances.members,
        transfers: simplifyDebts(balances.members),
      });
    }
    const totals = summariseForViewer(loaded);

    // The two totals are the per-group balances added up (TR-8), with the removed group absent.
    const positive = groups.reduce((total, g) => (g.balanceMinor > 0n ? total + g.balanceMinor : total), 0n);
    const negative = groups.reduce((total, g) => (g.balanceMinor < 0n ? total - g.balanceMinor : total), 0n);
    expect(totals.owedMinor).toBe(positive);
    expect(totals.oweMinor).toBe(negative);
    expect(totals.owedMinor).toBe(1100n);
    expect(totals.oweMinor).toBe(500n);

    // Each breakdown adds up to its own total, which is what "per-person" has to mean.
    expect(totals.owedBy.reduce((total, line) => total + line.amountMinor, 0n)).toBe(totals.owedMinor);
    expect(totals.oweTo.reduce((total, line) => total + line.amountMinor, 0n)).toBe(totals.oweMinor);
    expect(totals.owedBy.map((line) => line.displayName)).toEqual(['Sam', 'Dev']);
    expect(totals.oweTo.map((line) => line.displayName)).toEqual(['Sam']);

    // Two different people called Sam are two lines, not one: they are two memberships with two
    // balances, and merging them by name would print a number neither of them owes.
    expect(totals.owedBy[0]?.memberId).not.toBe(totals.oweTo[0]?.memberId);
    expect(lisbon.sam.id).not.toBe(portoSam.id);
  });
});

describe('the leave and remove guards', () => {
  /** Every membership and feed row, so "nothing was written" is one comparison. */
  async function snapshot() {
    const [memberRows, feedRows] = await Promise.all([
      db.select().from(members),
      db.select().from(activity),
    ]);
    return {
      rows: memberRows.map((row) => [row.id, row.removedAt?.getTime() ?? null] as const).sort(),
      feed: feedRows.map((row) => [row.kind, row.memberId] as const).sort(),
    };
  }

  it('refuses a leave with a non-zero balance, and writes nothing at all', async () => {
    const owner = await seedUser('leave-owner@example.invalid', 'Priya');
    const { sam, groupId, samMemberId } = await threeWayLedger(owner, 'Leave');
    const before = await snapshot();

    const refused = await withRequest(sam.cookies, () => leaveGroup(null, form({ groupId })));

    expect(refused).toEqual({ ok: false, formError: SETTLE_FIRST_MESSAGE });
    expect(await snapshot()).toEqual(before);
    const [row] = await db.select().from(members).where(eq(members.id, samMemberId));
    expect(row?.removedAt).toBeNull();
  });

  it('refuses a removal with the same sentence, and writes nothing at all', async () => {
    const owner = await seedUser('remove-owner@example.invalid', 'Priya');
    const { groupId, samMemberId } = await threeWayLedger(owner, 'Remove');
    const before = await snapshot();

    const refused = await withRequest(owner.cookies, () =>
      removeMember(null, form({ groupId, memberId: samMemberId })),
    );

    expect(refused).toEqual({ ok: false, formError: SETTLE_FIRST_MESSAGE });
    expect(await snapshot()).toEqual(before);
    const [row] = await db.select().from(members).where(eq(members.id, samMemberId));
    expect(row?.removedAt).toBeNull();
  });

  it('lets the same member leave once they are square', async () => {
    const owner = await seedUser('settle-leave-owner@example.invalid', 'Priya');
    const { sam, groupId, ownerMemberId, samMemberId } = await threeWayLedger(owner, 'Settled');

    // Sam owes 7.00; one expense of 14.00 paid by Sam and split between the two of them cancels
    // it exactly, and leaves Priya and Dev where they were relative to each other.
    await record(owner.cookies, {
      groupId,
      amount: '14',
      participants: [ownerMemberId, samMemberId],
      payers: [{ memberId: samMemberId, amount: '14' }],
    });

    expect(netOf((await nets(groupId, owner)).members, samMemberId)).toBe(0n);

    const left = await withRequest(sam.cookies, () => leaveGroup(null, form({ groupId })));
    expect(left.ok).toBe(true);

    const [row] = await db.select().from(members).where(eq(members.id, samMemberId));
    expect(row?.removedAt).not.toBeNull();
  });
});

describe('removing a settled member', () => {
  /** Two expenses that cancel: each paid by one of them, split between the two. */
  async function squareGroup(name: string) {
    const owner = await seedUser(`${name}-owner@example.invalid`, 'Priya');
    const sam = await seedUser(`${name}-sam@example.invalid`, 'Sam');
    const { groupId, ownerMemberId, memberIds } = await groupWith(owner, name, [sam]);
    const samMemberId = memberIds[0];
    const both = [ownerMemberId, samMemberId];

    await record(owner.cookies, {
      groupId,
      amount: '10',
      participants: both,
      payers: [{ memberId: ownerMemberId, amount: '10' }],
    });
    await record(owner.cookies, {
      groupId,
      amount: '10',
      participants: both,
      payers: [{ memberId: samMemberId, amount: '10' }],
    });

    return { owner, sam, groupId, ownerMemberId, samMemberId };
  }

  it('keeps their rows, leaves every other balance where it was, and still names them', async () => {
    const { owner, groupId, ownerMemberId, samMemberId } = await squareGroup('Keep');
    const before = await nets(groupId, owner);
    expect(before.members.map((member) => member.balanceMinor)).toEqual([0n, 0n]);

    const removed = await withRequest(owner.cookies, () =>
      removeMember(null, form({ groupId, memberId: samMemberId })),
    );
    expect(removed.ok).toBe(true);

    // The row is marked, never deleted: a stored share or payer row points at it.
    const [row] = await db.select().from(members).where(eq(members.id, samMemberId));
    expect(row?.removedAt).not.toBeNull();

    // Every row Sam was part of is still there, with its amount: one payer row (the expense they
    // paid for) and two share rows (one from each expense).
    const payers = await db.select().from(expensePayer).where(eq(expensePayer.memberId, samMemberId));
    const shares = await db.select().from(expenseShare).where(eq(expenseShare.memberId, samMemberId));
    expect(payers).toHaveLength(1);
    expect(payers[0]?.amountMinor).toBe(1000n);
    expect(shares).toHaveLength(2);

    // The owner's figure is untouched, computed over the same rows as before.
    const after = await nets(groupId, owner);
    expect(after.members.map((member) => member.memberId)).toEqual([ownerMemberId]);
    expect(netOf(after.members, ownerMemberId)).toBe(0n);

    // And the expenses still name them, which is what keeping the row is for.
    const listed = await readExpensesForGroup(db, groupId, owner.id);
    const named = (listed ?? []).flatMap((expense) => expense.payers.map((payer) => payer.displayName));
    expect(named.filter((name) => name === 'Sam')).toHaveLength(1);
  });

  it('never restates the other members, even for a row removed while it still owed', async () => {
    const owner = await seedUser('restate-owner@example.invalid', 'Priya');
    const sam = await seedUser('restate-sam@example.invalid', 'Sam');
    const { groupId, ownerMemberId, memberIds } = await groupWith(owner, 'Restate', [sam]);
    const samMemberId = memberIds[0];

    // Sam owes 10.00 and has no rows on the other side of it.
    await record(owner.cookies, {
      groupId,
      amount: '20',
      participants: [ownerMemberId, samMemberId],
      payers: [{ memberId: ownerMemberId, amount: '20' }],
    });

    const before = await nets(groupId, owner);
    expect(netOf(before.members, ownerMemberId)).toBe(1000n);
    expect(netOf(before.members, samMemberId)).toBe(-1000n);

    /**
     * The guard makes this unreachable through the app; setting it here is the only way to ask
     * what the READ does with it, which is the half of TR-16 that matters: a removed row still
     * carries its shares, so the members who are still here are not handed a different number.
     */
    await db.update(members).set({ removedAt: new Date() }).where(eq(members.id, samMemberId));

    const after = await nets(groupId, owner);
    expect(after.members.map((member) => member.memberId)).toEqual([ownerMemberId]);
    expect(netOf(after.members, ownerMemberId)).toBe(1000n);

    // The active members no longer sum to zero — Sam's −10.00 is on a row this read no longer
    // lists. That is the shape a removed member with a balance leaves behind, and it is exactly
    // why leave and remove refuse one: with the guard in place no group can reach this state.
    expect(sumBalances(after.members)).toBe(1000n);

    // The rows themselves are all still there, which is the other half.
    expect(
      await db.select().from(expenseShare).where(and(eq(expenseShare.memberId, samMemberId))),
    ).toHaveLength(1);
  });
});
