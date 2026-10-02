import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeTestDatabase, useTestDatabase } from '../helpers/pglite';
import { TestCookieStore, withRequest } from '../helpers/request';
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
import { readExpensesForGroup, readMembers } from '@/lib/access';
import { SESSION_COOKIE, hashPassword, hashToken, newSessionToken } from '@/lib/auth';
import { form } from '../helpers/request';

/**
 * The whole write path for an expense, against a real schema on a real (in-process) Postgres.
 *
 * The atomicity cases use the same switch the groups and members suites do: `recordActivity` is
 * the LAST write of the mutation, so making it throw is how "the expense, its rows and its feed
 * entry are one unit" is asserted from outside rather than by reading the transaction body and
 * agreeing with it.
 */
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
  // Hashed once and reused: scrypt at N=2^17 is ~360 ms, and no flow here verifies a password.
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
  return { id, displayName, cookies };
}

/**
 * A group with an owner and two members, whose memberships are ordered ON PURPOSE.
 *
 * createGroup writes the owner's row, and readMembers orders by `created_at` then `id` after the
 * owner — so two members inserted in the same instant would fall back to a random uuid and the
 * canonical order these tests assert against would be a coin toss. The timestamps are set here
 * rather than left to now() for exactly that reason.
 */
async function groupWithThree() {
  const owner = await seedUser('owner@example.invalid', 'Priya');
  const sam = await seedUser('sam@example.invalid', 'Sam');
  const dev = await seedUser('dev@example.invalid', 'Dev');

  const created = await withRequest(owner.cookies, () =>
    createGroup(null, form({ name: 'Lisbon', currency: 'EUR', type: 'trip' })),
  );
  if (!created.ok || !created.groupId) throw new Error(`createGroup refused: ${JSON.stringify(created)}`);
  const groupId = created.groupId;

  const [ownerRow] = await db.select().from(members).where(eq(members.groupId, groupId));
  if (!ownerRow) throw new Error('createGroup wrote no owner membership');

  const samMemberId = randomUUID();
  const devMemberId = randomUUID();
  await db.insert(members).values([
    {
      id: samMemberId,
      groupId,
      userId: sam.id,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    },
    {
      id: devMemberId,
      groupId,
      userId: dev.id,
      createdAt: new Date('2026-01-02T00:00:00.000Z'),
    },
  ]);

  // The canonical order readMembers returns, and the order the remainder rule is defined against.
  const canonical = [ownerRow.id, samMemberId, devMemberId];

  return { owner, sam, dev, groupId, ownerMemberId: ownerRow.id, samMemberId, devMemberId, canonical };
}

interface ExpenseInput {
  groupId: string;
  description?: string;
  amount?: string;
  date?: string;
  category?: string;
  note?: string;
  splitType?: string;
  participants?: string[];
  payers?: { memberId: string; amount: string }[];
  inputs?: Record<string, string>;
}

/**
 * The FormData a browser would post. The repeated `participant` and `payer` fields and the
 * `input.<memberId>` / `payerAmount.<memberId>` names are the form's contract with the action,
 * so they are built here the way the form builds them rather than by calling the action with an
 * object the form could never produce.
 */
function expenseForm(values: ExpenseInput): FormData {
  const data = new FormData();
  data.append('groupId', values.groupId);
  data.append('description', values.description ?? 'Dinner');
  data.append('amount', values.amount ?? '10');
  data.append('date', values.date ?? '2026-10-01');
  data.append('category', values.category ?? '');
  data.append('note', values.note ?? '');
  data.append('splitType', values.splitType ?? 'equal');
  for (const memberId of values.participants ?? []) data.append('participant', memberId);
  for (const payer of values.payers ?? []) {
    data.append('payer', payer.memberId);
    data.append(`payerAmount.${payer.memberId}`, payer.amount);
  }
  for (const [memberId, value] of Object.entries(values.inputs ?? {})) {
    data.append(`input.${memberId}`, value);
  }
  return data;
}

async function recordAs(
  cookies: TestCookieStore,
  values: ExpenseInput,
) {
  return await withRequest(cookies, () => createExpense(null, expenseForm(values)));
}

/**
 * Every expense-shaped row in the database, so "nothing was written" is one assertion.
 *
 * The feed is counted down to `expense.added`: creating the group these tests write into is
 * itself a feed entry, and counting it would make every refusal look like a partial write.
 */
async function rowCounts() {
  const [expenseRows, payerRows, shareRows, inputRows, activityRows] = await Promise.all([
    db.select().from(expenses),
    db.select().from(expensePayer),
    db.select().from(expenseShare),
    db.select().from(expenseSplitInput),
    db.select().from(activity).where(eq(activity.kind, 'expense.added')),
  ]);
  return {
    expenses: expenseRows.length,
    payers: payerRows.length,
    shares: shareRows.length,
    inputs: inputRows.length,
    activity: activityRows.length,
  };
}

describe('recording an expense', () => {
  it('writes the expense, its payer, its shares and its rule rows in one transaction', async () => {
    const { owner, groupId, ownerMemberId, samMemberId, devMemberId, canonical } = await groupWithThree();

    const result = await recordAs(owner.cookies, {
      groupId,
      description: 'Dinner',
      amount: '10',
      date: '2026-09-30',
      category: 'food',
      participants: canonical,
      payers: [{ memberId: ownerMemberId, amount: '10' }],
      splitType: 'equal',
    });
    expect(result).toEqual({ ok: true, groupId });

    const [expense] = await db.select().from(expenses);
    expect(expense).toBeDefined();
    expect(expense?.description).toBe('Dinner');
    // AC-1: integer minor units, never a float. 10 EUR is 1000, not 10 and not 10.0.
    expect(expense?.amountMinor).toBe(1000n);
    expect(expense?.currency).toBe('EUR');
    expect(expense?.splitType).toBe('equal');
    expect(expense?.category).toBe('food');
    expect(expense?.date).toBe('2026-09-30');
    expect(expense?.createdBy).toBe(owner.id);

    const payers = await db.select().from(expensePayer);
    expect(payers).toEqual([{ expenseId: expense?.id, memberId: ownerMemberId, amountMinor: 1000n }]);

    // 1000 between three leaves 1, and TR-3 hands the whole remainder to the FIRST member in
    // canonical order — the owner — rather than spreading it or rounding anyone down.
    const shares = await db.select().from(expenseShare);
    const byMember = new Map(shares.map((share) => [share.memberId, share.amountMinor]));
    expect(byMember.get(ownerMemberId)).toBe(334n);
    expect(byMember.get(samMemberId)).toBe(333n);
    expect(byMember.get(devMemberId)).toBe(333n);
    expect(shares.reduce((sum, share) => sum + share.amountMinor, 0n)).toBe(1000n);

    // The entered RULE is stored beside the amounts it produced: one row per included member,
    // null for an equal split, where the only stored input is membership (AC-9).
    const inputs = await db.select().from(expenseSplitInput);
    expect(inputs).toHaveLength(3);
    expect(new Set(inputs.map((row) => row.memberId))).toEqual(
      new Set([ownerMemberId, samMemberId, devMemberId]),
    );
    expect(inputs.every((row) => row.inputValue === null)).toBe(true);
  });

  it('records two payers whose parts sum exactly to the total (AC-7, AC-8)', async () => {
    const { owner, groupId, ownerMemberId, samMemberId, canonical } = await groupWithThree();

    const result = await recordAs(owner.cookies, {
      groupId,
      amount: '10',
      participants: canonical,
      payers: [
        { memberId: ownerMemberId, amount: '6' },
        { memberId: samMemberId, amount: '4' },
      ],
    });
    expect(result.ok).toBe(true);

    const payers = await db.select().from(expensePayer);
    expect(payers).toHaveLength(2);
    expect(payers.reduce((sum, payer) => sum + payer.amountMinor, 0n)).toBe(1000n);
    expect(payers.map((payer) => payer.memberId).sort()).toEqual([ownerMemberId, samMemberId].sort());
  });

  it('accepts a payer who is not in the split (AC-8)', async () => {
    const { owner, groupId, ownerMemberId, samMemberId } = await groupWithThree();

    // Sam owes a third of this and paid none of it; Priya paid all of it and is owed her share
    // back. Refusing this would make the ordinary "I covered it" expense unrecordable.
    const result = await recordAs(owner.cookies, {
      groupId,
      amount: '10',
      participants: [samMemberId],
      payers: [{ memberId: ownerMemberId, amount: '10' }],
    });
    expect(result.ok).toBe(true);

    expect((await db.select().from(expensePayer)).map((row) => row.memberId)).toEqual([ownerMemberId]);
    expect((await db.select().from(expenseShare)).map((row) => row.memberId)).toEqual([samMemberId]);
  });

  it('gives an unchecked member no share row and no rule row (AC-4)', async () => {
    const { owner, groupId, ownerMemberId, samMemberId, devMemberId } = await groupWithThree();

    await recordAs(owner.cookies, {
      groupId,
      amount: '10',
      participants: [ownerMemberId, samMemberId],
      payers: [{ memberId: ownerMemberId, amount: '10' }],
    });

    const shares = await db.select().from(expenseShare);
    const inputs = await db.select().from(expenseSplitInput);
    expect(shares.map((row) => row.memberId)).not.toContain(devMemberId);
    expect(inputs.map((row) => row.memberId)).not.toContain(devMemberId);
    // 1000 between two is 500 each: the excluded member's absence changes the division.
    expect(shares.map((row) => row.amountMinor).sort()).toEqual([500n, 500n]);
  });

  it('writes exactly one activity entry, carrying the expense as its subject and what it was', async () => {
    const { owner, groupId, ownerMemberId } = await groupWithThree();

    await recordAs(owner.cookies, {
      groupId,
      description: 'Taxi',
      amount: '31.50',
      date: '2026-10-01',
      category: 'travel',
      participants: [ownerMemberId],
      payers: [{ memberId: ownerMemberId, amount: '31.50' }],
    });

    const [expense] = await db.select().from(expenses);
    // Creating the group wrote one feed entry of its own; this is about the expense's.
    const entries = await db.select().from(activity).where(eq(activity.kind, 'expense.added'));
    expect(entries).toHaveLength(1);

    const entry = entries[0];
    expect(entry?.kind).toBe('expense.added');
    expect(entry?.groupId).toBe(groupId);
    expect(entry?.actorId).toBe(owner.id);
    expect(entry?.subjectType).toBe('expense');
    expect(entry?.subjectId).toBe(expense?.id);
    expect(entry?.detail).toEqual({
      description: 'Taxi',
      // A string, never a number: jsonb numbers are floats and this is a money value.
      amountMinor: '3150',
      currency: 'EUR',
      splitType: 'equal',
      category: 'travel',
      date: '2026-10-01',
    });
  });

  it('leaves nothing behind when the feed write fails — the expense and its entry are one unit', async () => {
    const { owner, groupId, ownerMemberId } = await groupWithThree();

    feed.fail = true;
    await expect(
      recordAs(owner.cookies, {
        groupId,
        participants: [ownerMemberId],
        payers: [{ memberId: ownerMemberId, amount: '10' }],
      }),
    ).rejects.toThrow('the feed write failed');

    expect(await rowCounts()).toEqual({ expenses: 0, payers: 0, shares: 0, inputs: 0, activity: 0 });
  });
});

describe('how an expense splits', () => {
  it('stores the numbers that were entered, one rule row per included member (AC-9)', async () => {
    const { owner, groupId, ownerMemberId, samMemberId, devMemberId } = await groupWithThree();

    const result = await recordAs(owner.cookies, {
      groupId,
      amount: '10',
      splitType: 'percentage',
      participants: [devMemberId, ownerMemberId, samMemberId],
      inputs: { [ownerMemberId]: '25', [samMemberId]: '25', [devMemberId]: '50' },
      payers: [{ memberId: ownerMemberId, amount: '10' }],
    });
    expect(result.ok).toBe(true);

    // Hundredths of a percent, and the row set is keyed by member rather than by position: the
    // order somebody ticked the boxes in is not stored, because the canonical order reconstructs
    // it (TR-3, and the work order's own rejected alternative of an ordinal column).
    const inputs = await db.select().from(expenseSplitInput);
    const byMember = new Map(inputs.map((row) => [row.memberId, row.inputValue]));
    expect(byMember.get(ownerMemberId)).toBe(2500n);
    expect(byMember.get(samMemberId)).toBe(2500n);
    expect(byMember.get(devMemberId)).toBe(5000n);

    // And the shares the rule produced: 25%, 25% and 50% of 1000.
    const shares = await db.select().from(expenseShare);
    const shareByMember = new Map(shares.map((row) => [row.memberId, row.amountMinor]));
    expect(shareByMember.get(ownerMemberId)).toBe(250n);
    expect(shareByMember.get(samMemberId)).toBe(250n);
    expect(shareByMember.get(devMemberId)).toBe(500n);
  });

  it('stores share counts for a shares split and the remainder falls on the first member', async () => {
    const { owner, groupId, ownerMemberId, samMemberId, devMemberId } = await groupWithThree();

    await recordAs(owner.cookies, {
      groupId,
      amount: '10',
      splitType: 'shares',
      participants: [ownerMemberId, samMemberId, devMemberId],
      inputs: { [ownerMemberId]: '1', [samMemberId]: '1', [devMemberId]: '1' },
      payers: [{ memberId: ownerMemberId, amount: '10' }],
    });

    const inputs = await db.select().from(expenseSplitInput);
    expect(inputs.every((row) => row.inputValue === 1n)).toBe(true);

    // 1000 between three equal shares is 333 each and 1 over, and the whole of it goes to the
    // owner — 334/333/333, not 334/334/332.
    const shares = await db.select().from(expenseShare);
    const byMember = new Map(shares.map((row) => [row.memberId, row.amountMinor]));
    expect([byMember.get(ownerMemberId), byMember.get(samMemberId), byMember.get(devMemberId)]).toEqual([
      334n,
      333n,
      333n,
    ]);
  });

  it('refuses exact amounts that do not add up, naming the shortfall in minor units (AC-5)', async () => {
    const { owner, groupId, ownerMemberId, samMemberId, devMemberId } = await groupWithThree();

    const result = await recordAs(owner.cookies, {
      groupId,
      amount: '10',
      splitType: 'exact',
      participants: [ownerMemberId, samMemberId, devMemberId],
      inputs: { [ownerMemberId]: '4', [samMemberId]: '3', [devMemberId]: '0' },
      payers: [{ memberId: ownerMemberId, amount: '10' }],
    });

    expect(result.ok).toBe(false);
    expect(result.fieldErrors?.split).toBe('Exact amounts add up to €7.00 — €3.00 short of the total.');
    // The totals are already right, so the refusal is about the split alone.
    expect(result.fieldErrors?.payers).toBeUndefined();
    expect(await rowCounts()).toEqual({ expenses: 0, payers: 0, shares: 0, inputs: 0, activity: 0 });
  });

  it('refuses percentages that do not reach 100, naming both the gap and the money (AC-5)', async () => {
    const { owner, groupId, ownerMemberId, samMemberId, devMemberId } = await groupWithThree();

    const result = await recordAs(owner.cookies, {
      groupId,
      amount: '10',
      splitType: 'percentage',
      participants: [ownerMemberId, samMemberId, devMemberId],
      inputs: { [ownerMemberId]: '33.33', [samMemberId]: '33.33', [devMemberId]: '0' },
      payers: [{ memberId: ownerMemberId, amount: '10' }],
    });

    expect(result.ok).toBe(false);
    expect(result.fieldErrors?.split).toBe(
      'Percentages add up to 66.66% — 33.34% short of 100%, leaving €3.33 unassigned.',
    );
    expect(await rowCounts()).toEqual({ expenses: 0, payers: 0, shares: 0, inputs: 0, activity: 0 });
  });

  it('refuses a split nobody is in, beside the picker, and writes nothing (AC-4)', async () => {
    const { owner, groupId, ownerMemberId } = await groupWithThree();

    const result = await recordAs(owner.cookies, {
      groupId,
      participants: [],
      payers: [{ memberId: ownerMemberId, amount: '10' }],
    });

    expect(result.ok).toBe(false);
    expect(result.fieldErrors?.participants).toBe(
      'Choose at least one member to split this expense between.',
    );
    expect(await rowCounts()).toEqual({ expenses: 0, payers: 0, shares: 0, inputs: 0, activity: 0 });
  });

  it('refuses a set of shares that is all zeroes', async () => {
    const { owner, groupId, ownerMemberId, samMemberId } = await groupWithThree();

    const result = await recordAs(owner.cookies, {
      groupId,
      splitType: 'shares',
      participants: [ownerMemberId, samMemberId],
      inputs: { [ownerMemberId]: '0', [samMemberId]: '0' },
      payers: [{ memberId: ownerMemberId, amount: '10' }],
    });

    expect(result.ok).toBe(false);
    expect(result.fieldErrors?.split).toBe('Give at least one member a share above zero.');
    expect((await rowCounts()).expenses).toBe(0);
  });
});

describe('who paid', () => {
  it('refuses a set of payers that does not sum to the total, naming the gap (AC-7)', async () => {
    const { owner, groupId, ownerMemberId, samMemberId, canonical } = await groupWithThree();

    const short = await recordAs(owner.cookies, {
      groupId,
      amount: '10',
      participants: canonical,
      payers: [
        { memberId: ownerMemberId, amount: '6' },
        { memberId: samMemberId, amount: '3' },
      ],
    });
    expect(short.ok).toBe(false);
    expect(short.fieldErrors?.payers).toBe('Payers add up to €9.00 — €1.00 short of the total.');

    const over = await recordAs(owner.cookies, {
      groupId,
      amount: '10',
      participants: canonical,
      payers: [{ memberId: ownerMemberId, amount: '12' }],
    });
    expect(over.ok).toBe(false);
    expect(over.fieldErrors?.payers).toBe('Payers add up to €12.00 — €2.00 over the total.');

    expect(await rowCounts()).toEqual({ expenses: 0, payers: 0, shares: 0, inputs: 0, activity: 0 });
  });

  it('refuses the same member twice as a payer by name, not as a constraint violation', async () => {
    const { owner, groupId, ownerMemberId, canonical } = await groupWithThree();

    // The composite primary key on (expense_id, member_id) would make this a duplicate-key 500
    // if it reached the insert. It is a request the form cannot make, so it is refused by name.
    const result = await recordAs(owner.cookies, {
      groupId,
      participants: canonical,
      payers: [
        { memberId: ownerMemberId, amount: '5' },
        { memberId: ownerMemberId, amount: '5' },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.fieldErrors?.payers).toBe('Priya is listed twice as a payer.');
    expect((await rowCounts()).expenses).toBe(0);
  });

  it('refuses a payer amount of zero', async () => {
    const { owner, groupId, ownerMemberId, canonical } = await groupWithThree();

    const result = await recordAs(owner.cookies, {
      groupId,
      participants: canonical,
      payers: [{ memberId: ownerMemberId, amount: '0' }],
    });

    expect(result.ok).toBe(false);
    expect(result.fieldErrors?.payers).toBe('Enter what Priya paid.');
  });

  it('refuses an expense nobody paid for', async () => {
    const { owner, groupId, canonical } = await groupWithThree();

    const result = await recordAs(owner.cookies, { groupId, participants: canonical, payers: [] });

    expect(result.ok).toBe(false);
    expect(result.fieldErrors?.payers).toBe('Choose who paid.');
  });
});

describe('what an expense is checked against', () => {
  it('refuses zero, negative, whitespace-only and over-length input, each beside its own field', async () => {
    const { owner, groupId, ownerMemberId } = await groupWithThree();
    const base = {
      groupId,
      participants: [ownerMemberId],
      payers: [{ memberId: ownerMemberId, amount: '10' }],
    };

    const zero = await recordAs(owner.cookies, { ...base, amount: '0' });
    expect(zero.fieldErrors?.amount).toBe('Enter an amount greater than zero.');

    const negative = await recordAs(owner.cookies, { ...base, amount: '-5' });
    expect(negative.fieldErrors?.amount).toBe('Enter a positive amount, without a sign.');

    const blankDescription = await recordAs(owner.cookies, { ...base, description: '   ' });
    expect(blankDescription.fieldErrors?.description).toBe('Enter what this expense was for.');

    const longDescription = await recordAs(owner.cookies, { ...base, description: 'x'.repeat(201) });
    expect(longDescription.fieldErrors?.description).toBe('Keep the description under 200 characters.');

    const longNote = await recordAs(owner.cookies, { ...base, note: 'y'.repeat(501) });
    expect(longNote.fieldErrors?.note).toBe('Keep the note under 500 characters.');

    // 2026-02-30 matches the shape and is not a date; the calendar is the only judge of that.
    const notADate = await recordAs(owner.cookies, { ...base, date: '2026-02-30' });
    expect(notADate.fieldErrors?.date).toBe('Enter the date this happened on.');

    const badCategory = await recordAs(owner.cookies, { ...base, category: 'pizza' });
    expect(badCategory.fieldErrors?.category).toBe('Choose one of the categories.');

    expect(await rowCounts()).toEqual({ expenses: 0, payers: 0, shares: 0, inputs: 0, activity: 0 });
  });

  it('reports several bad fields at once rather than one per round trip', async () => {
    const { owner, groupId, ownerMemberId } = await groupWithThree();

    const result = await recordAs(owner.cookies, {
      groupId,
      description: '   ',
      amount: '0',
      date: 'not-a-date',
      participants: [ownerMemberId],
      payers: [{ memberId: ownerMemberId, amount: '10' }],
    });

    // `payers` is here because a total of zero is over-paid by the single €10 payer, and saying
    // so is the same check that catches a mistyped total — not a second failure to fix.
    expect(result.ok).toBe(false);
    expect(Object.keys(result.fieldErrors ?? {}).sort()).toEqual([
      'amount',
      'date',
      'description',
      'payers',
    ]);
  });

  it('refuses a member who has left the group since the form was rendered', async () => {
    const { owner, groupId, ownerMemberId, samMemberId } = await groupWithThree();

    // Sam left between the page render and the submit. Their id is in the form, and it is not in
    // the group any more — which is a form-level refusal, because there is no field to put it on.
    await db
      .update(members)
      .set({ removedAt: new Date() })
      .where(eq(members.id, samMemberId));

    const result = await recordAs(owner.cookies, {
      groupId,
      participants: [ownerMemberId, samMemberId],
      payers: [{ memberId: ownerMemberId, amount: '10' }],
    });

    expect(result.ok).toBe(false);
    expect(result.formError).toBe(
      'Somebody in this expense is no longer in this group. Reload the page and try again.',
    );
    expect((await rowCounts()).expenses).toBe(0);
  });

  it('refuses a member id that was never in the group', async () => {
    const { owner, groupId, ownerMemberId } = await groupWithThree();

    const result = await recordAs(owner.cookies, {
      groupId,
      participants: [ownerMemberId, randomUUID()],
      payers: [{ memberId: ownerMemberId, amount: '10' }],
    });

    expect(result.ok).toBe(false);
    expect(result.formError).toBeDefined();
    expect((await rowCounts()).expenses).toBe(0);
  });
});

describe('the category and the note', () => {
  it('round-trips a category and leaves an unset one null rather than empty', async () => {
    const { owner, groupId, ownerMemberId } = await groupWithThree();
    const base = {
      groupId,
      participants: [ownerMemberId],
      payers: [{ memberId: ownerMemberId, amount: '10' }],
    };

    await recordAs(owner.cookies, { ...base, description: 'Rent', category: 'rent' });
    await recordAs(owner.cookies, { ...base, description: 'Dinner', category: '' });

    const rows = await db.select().from(expenses);
    const byDescription = new Map(rows.map((row) => [row.description, row.category]));
    expect(byDescription.get('Rent')).toBe('rent');
    // Null, not the empty string: the chip renders on a value, and '' is a value.
    expect(byDescription.get('Dinner')).toBeNull();
  });

  it('trims a note and stores a blank one as null', async () => {
    const { owner, groupId, ownerMemberId } = await groupWithThree();
    const base = {
      groupId,
      participants: [ownerMemberId],
      payers: [{ memberId: ownerMemberId, amount: '10' }],
    };

    await recordAs(owner.cookies, { ...base, description: 'Taxi', note: '  bolt, not uber  ' });
    await recordAs(owner.cookies, { ...base, description: 'Dinner', note: '   ' });

    const rows = await db.select().from(expenses);
    const byDescription = new Map(rows.map((row) => [row.description, row.note]));
    expect(byDescription.get('Taxi')).toBe('bolt, not uber');
    expect(byDescription.get('Dinner')).toBeNull();
  });
});

describe('who may record an expense, and who may read one', () => {
  it('refuses a non-member with the same sentence a missing group gets, and writes nothing (AC-16)', async () => {
    const { owner, groupId, ownerMemberId, canonical } = await groupWithThree();
    const stranger = await seedUser('stranger@example.invalid', 'Sam');

    const asStranger = await recordAs(stranger.cookies, {
      groupId,
      participants: canonical,
      payers: [{ memberId: ownerMemberId, amount: '10' }],
    });

    // The same answer for "you are not in this group" and "there is no such group": neither may
    // leak which one it was.
    const asNobody = await recordAs(owner.cookies, {
      groupId: randomUUID(),
      participants: [ownerMemberId],
      payers: [{ memberId: ownerMemberId, amount: '10' }],
    });

    expect(asStranger.ok).toBe(false);
    expect(asStranger.formError).toBe('That group is not available.');
    expect(asStranger.formError).toBe(asNobody.formError);

    expect(await rowCounts()).toEqual({ expenses: 0, payers: 0, shares: 0, inputs: 0, activity: 0 });
  });

  it('refuses an id that is not a uuid before it reaches the database', async () => {
    const { owner, ownerMemberId } = await groupWithThree();

    const result = await recordAs(owner.cookies, {
      groupId: 'not-a-uuid',
      participants: [ownerMemberId],
      payers: [{ memberId: ownerMemberId, amount: '10' }],
    });

    // Not a malformed-uuid 500 from Postgres: the same sentence, decided before the query.
    expect(result).toEqual({ ok: false, formError: 'That group is not available.' });
  });

  it('returns nothing to a non-member and null for a group that does not exist', async () => {
    const { owner, groupId, ownerMemberId, canonical } = await groupWithThree();
    const stranger = await seedUser('stranger@example.invalid', 'Sam');

    await recordAs(owner.cookies, {
      groupId,
      participants: canonical,
      payers: [{ memberId: ownerMemberId, amount: '10' }],
    });

    expect(await readExpensesForGroup(db, groupId, owner.id)).toHaveLength(1);
    // Null, not an empty list: an empty list would say "this group has no expenses", which is a
    // different and more informative answer than "you may not ask".
    expect(await readExpensesForGroup(db, groupId, stranger.id)).toBeNull();
    expect(await readExpensesForGroup(db, randomUUID(), owner.id)).toBeNull();
  });
});

describe('the list read', () => {
  it('orders newest first by expense date, with created_at then id breaking a tie', async () => {
    const { owner, groupId, ownerMemberId } = await groupWithThree();
    const base = {
      groupId,
      participants: [ownerMemberId],
      payers: [{ memberId: ownerMemberId, amount: '10' }],
    };

    // Recorded out of date order on purpose, and two of them on the SAME date so the tie-break
    // is what decides between them.
    await recordAs(owner.cookies, { ...base, description: 'Monday', date: '2026-09-28' });
    await recordAs(owner.cookies, { ...base, description: 'Friday', date: '2026-10-02' });
    await recordAs(owner.cookies, { ...base, description: 'Wednesday', date: '2026-09-30' });

    const rows = await readExpensesForGroup(db, groupId, owner.id);
    expect(rows?.map((row) => row.description)).toEqual(['Friday', 'Wednesday', 'Monday']);

    // The date is a calendar date all the way out: 'YYYY-MM-DD', never shifted through a Date.
    expect(rows?.[0]?.date).toBe('2026-10-02');
  });

  it('resolves each row’s payers, in the canonical member order', async () => {
    const { owner, groupId, ownerMemberId, samMemberId, canonical } = await groupWithThree();

    await recordAs(owner.cookies, {
      groupId,
      description: 'Taxi',
      amount: '10',
      participants: canonical,
      payers: [
        { memberId: samMemberId, amount: '4' },
        { memberId: ownerMemberId, amount: '6' },
      ],
    });

    const rows = await readExpensesForGroup(db, groupId, owner.id);
    expect(rows).toHaveLength(1);
    // Submitted Sam-then-Priya; returned owner-first, because the read orders by the group's
    // canonical member order rather than by anything the form said.
    expect(rows?.[0]?.payers.map((payer) => payer.displayName)).toEqual(['Priya', 'Sam']);
    expect(rows?.[0]?.payers.map((payer) => payer.amountMinor)).toEqual([600n, 400n]);
  });

  it('carries the group’s currency and the rule that was entered', async () => {
    const { owner, groupId, ownerMemberId, samMemberId } = await groupWithThree();

    await recordAs(owner.cookies, {
      groupId,
      description: 'Rent',
      amount: '1234.56',
      category: 'rent',
      splitType: 'exact',
      participants: [ownerMemberId, samMemberId],
      inputs: { [ownerMemberId]: '1000', [samMemberId]: '234.56' },
      payers: [{ memberId: ownerMemberId, amount: '1234.56' }],
    });

    const [row] = (await readExpensesForGroup(db, groupId, owner.id)) ?? [];
    expect(row?.currency).toBe('EUR');
    expect(row?.amountMinor).toBe(123456n);
    expect(row?.splitType).toBe('exact');
    expect(row?.category).toBe('rent');
  });

  it('lists the group’s members in the canonical order the split is defined against', async () => {
    const { owner, groupId, ownerMemberId, samMemberId, devMemberId } = await groupWithThree();

    const listed = await readMembers(db, groupId, owner.id);
    expect(listed?.map((member) => member.memberId)).toEqual([ownerMemberId, samMemberId, devMemberId]);
    expect(listed?.map((member) => member.displayName)).toEqual(['Priya', 'Sam', 'Dev']);
  });
});
