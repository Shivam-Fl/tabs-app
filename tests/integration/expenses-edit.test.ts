import { randomUUID } from 'node:crypto';
import { eq, isNull, sql } from 'drizzle-orm';
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
import { createExpense, deleteExpense, updateExpense } from '@/app/actions/expenses';
import { createGroup } from '@/app/actions/groups';
import { readExpenseForEdit } from '@/lib/access';
import { SESSION_COOKIE, hashPassword, hashToken, newSessionToken } from '@/lib/auth';
import { formatMajorUnits, formatSplitInput } from '@/lib/money';

/**
 * Editing and deleting a stored expense, against a real schema on a real (in-process) Postgres.
 *
 * The two claims these cases exist for are the ones a component test cannot make: that an edit
 * REPLACES the ledger rows rather than re-deriving them (so changing the rounding rule cannot
 * restate anybody's history, AC-8), and that a reopened expense saved untouched reproduces the
 * rows it was reopened from (AC-6). Both are asserted by reading the tables back, never by
 * agreeing with the transaction body.
 *
 * Balances are derived in this file the way a balance read derives them — payers minus shares,
 * over the expenses that are still live — because a balance is a sum over those rows and nothing
 * else (TR-4).
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
 * A group with an owner and two members whose memberships are ordered ON PURPOSE: readMembers
 * orders by created_at then id after the owner, so two rows written in the same instant would
 * fall back to a random uuid and the canonical order these tests assert against would be a coin
 * toss.
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
    { id: samMemberId, groupId, userId: sam.id, createdAt: new Date('2026-01-01T00:00:00.000Z') },
    { id: devMemberId, groupId, userId: dev.id, createdAt: new Date('2026-01-02T00:00:00.000Z') },
  ]);

  return { owner, sam, dev, groupId, ownerMemberId: ownerRow.id, samMemberId, devMemberId };
}

interface ExpenseInput {
  groupId: string;
  expenseId?: string;
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
 * The FormData the shared expense form posts. The repeated `participant` and `payer` fields and
 * the `input.<memberId>` / `payerAmount.<memberId>` names are the form's contract with all three
 * actions, so they are built here the way the form builds them.
 */
function expenseForm(values: ExpenseInput): FormData {
  const data = new FormData();
  data.append('groupId', values.groupId);
  if (values.expenseId) data.append('expenseId', values.expenseId);
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

async function recordAs(cookies: TestCookieStore, values: ExpenseInput) {
  return await withRequest(cookies, () => createExpense(null, expenseForm(values)));
}

async function editAs(cookies: TestCookieStore, values: ExpenseInput) {
  return await withRequest(cookies, () => updateExpense(null, expenseForm(values)));
}

async function deleteAs(cookies: TestCookieStore, groupId: string, expenseId: string) {
  return await withRequest(cookies, () => deleteExpense(null, form({ groupId, expenseId })));
}

/** The one expense the setup wrote. */
async function onlyExpense() {
  const rows = await db.select().from(expenses);
  if (rows.length !== 1) throw new Error(`expected one expense, found ${rows.length}`);
  return rows[0];
}

/**
 * Every member's net position: what they paid minus what they owe, as a balance read derives it.
 * Every membership starts at zero, so a member who has dropped out of every live expense reads as
 * settled rather than as absent — which is the difference an edit has to have made.
 */
async function balances(): Promise<Record<string, string>> {
  const live = new Set(
    (await db.select({ id: expenses.id }).from(expenses).where(isNull(expenses.deletedAt))).map(
      (row) => row.id,
    ),
  );

  const net = new Map<string, bigint>(
    (await db.select({ id: members.id }).from(members)).map((row) => [row.id, 0n]),
  );
  const add = (memberId: string, delta: bigint) =>
    net.set(memberId, (net.get(memberId) ?? 0n) + delta);

  for (const row of await db.select().from(expensePayer)) {
    if (live.has(row.expenseId)) add(row.memberId, row.amountMinor);
  }
  for (const row of await db.select().from(expenseShare)) {
    if (live.has(row.expenseId)) add(row.memberId, -row.amountMinor);
  }

  return Object.fromEntries([...net].map(([memberId, value]) => [memberId, value.toString()]));
}

/**
 * The three child row sets, sorted so a comparison between two reads is about what is stored and
 * never about the order the database happened to return it in.
 */
async function childRows() {
  const key = (row: { expenseId: string; memberId: string }) => `${row.expenseId}:${row.memberId}`;
  return {
    payers: (await db.select().from(expensePayer)).sort((a, b) => key(a).localeCompare(key(b))),
    shares: (await db.select().from(expenseShare)).sort((a, b) => key(a).localeCompare(key(b))),
    inputs: (await db.select().from(expenseSplitInput)).sort((a, b) => key(a).localeCompare(key(b))),
  };
}

async function entriesOf(kind: 'expense.edited' | 'expense.deleted' | 'expense.added') {
  return await db.select().from(activity).where(eq(activity.kind, kind));
}

/** The single feed entry of a kind, or a failure naming how many there were instead. */
async function onlyEntry(kind: 'expense.edited' | 'expense.deleted') {
  const entries = await entriesOf(kind);
  if (entries.length !== 1) throw new Error(`expected one ${kind} entry, found ${entries.length}`);
  return entries[0];
}

describe('editing an expense', () => {
  it('replaces the parent row and all three child row sets, and moves each balance by the difference (AC-4)', async () => {
    const { owner, groupId, ownerMemberId, samMemberId, devMemberId } = await groupWithThree();

    await recordAs(owner.cookies, {
      groupId,
      description: 'Dinner',
      amount: '9',
      participants: [ownerMemberId, samMemberId, devMemberId],
      payers: [{ memberId: ownerMemberId, amount: '9' }],
    });
    const expense = await onlyExpense();
    // 900 between three: 300 each, so Priya is 600 up and the other two 300 down.
    expect(await balances()).toEqual({
      [ownerMemberId]: '600',
      [samMemberId]: '-300',
      [devMemberId]: '-300',
    });

    const result = await editAs(owner.cookies, {
      groupId,
      expenseId: expense.id,
      description: 'Dinner, and the taxi',
      amount: '10',
      date: '2026-10-02',
      splitType: 'exact',
      participants: [samMemberId, devMemberId],
      inputs: { [samMemberId]: '4', [devMemberId]: '6' },
      payers: [{ memberId: samMemberId, amount: '10' }],
    });
    expect(result).toEqual({ ok: true, groupId });

    // One row, not two: the expense was rewritten, and the ledger is what it now says.
    const rows = await db.select().from(expenses);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.description).toBe('Dinner, and the taxi');
    expect(rows[0]?.amountMinor).toBe(1000n);
    expect(rows[0]?.splitType).toBe('exact');
    expect(rows[0]?.date).toBe('2026-10-02');

    // The payer, share and rule rows are the new ones — the old sets are gone, not appended to.
    expect(await db.select().from(expensePayer)).toEqual([
      { expenseId: expense.id, memberId: samMemberId, amountMinor: 1000n },
    ]);
    const shares = await db.select().from(expenseShare);
    expect(new Map(shares.map((row) => [row.memberId, row.amountMinor]))).toEqual(
      new Map([
        [samMemberId, 400n],
        [devMemberId, 600n],
      ]),
    );
    const inputs = await db.select().from(expenseSplitInput);
    expect(new Map(inputs.map((row) => [row.memberId, row.inputValue]))).toEqual(
      new Map([
        [samMemberId, 400n],
        [devMemberId, 600n],
      ]),
    );

    // Every balance moved by exactly new-minus-old: Priya is out of it entirely, Sam is 600 up
    // (he paid 1000 and owes 400) and Dev owes 600.
    expect(await balances()).toEqual({
      [ownerMemberId]: '0',
      [samMemberId]: '600',
      [devMemberId]: '-600',
    });

    // Exactly one entry, and it is the edit — not a second expense.added.
    expect(await entriesOf('expense.edited')).toHaveLength(1);
    expect(await entriesOf('expense.added')).toHaveLength(1);
  });

  it('records only the fields that moved, each with its old and new value (AC-5)', async () => {
    const { owner, groupId, ownerMemberId, samMemberId } = await groupWithThree();

    await recordAs(owner.cookies, {
      groupId,
      description: 'Dinner',
      amount: '10',
      participants: [ownerMemberId, samMemberId],
      payers: [{ memberId: ownerMemberId, amount: '10' }],
    });
    const expense = await onlyExpense();

    const result = await editAs(owner.cookies, {
      groupId,
      expenseId: expense.id,
      description: 'Supper',
      amount: '10',
      note: 'the one by the river',
      participants: [ownerMemberId, samMemberId],
      payers: [{ memberId: ownerMemberId, amount: '10' }],
    });
    expect(result.ok).toBe(true);

    // Two fields moved and two are recorded. The amount, the date, the split type, the payers and
    // the participants were all re-submitted identically, and none of them appears.
    expect((await onlyEntry('expense.edited')).detail).toEqual({
      description: { from: 'Dinner', to: 'Supper' },
      note: { from: null, to: 'the one by the river' },
    });
  });

  it('records the amount as a string and the payer list when the total moves (AC-5)', async () => {
    const { owner, groupId, ownerMemberId, samMemberId } = await groupWithThree();

    await recordAs(owner.cookies, {
      groupId,
      amount: '10',
      participants: [ownerMemberId, samMemberId],
      payers: [{ memberId: ownerMemberId, amount: '10' }],
    });
    const expense = await onlyExpense();

    await editAs(owner.cookies, {
      groupId,
      expenseId: expense.id,
      amount: '20',
      participants: [ownerMemberId, samMemberId],
      payers: [
        { memberId: ownerMemberId, amount: '12' },
        { memberId: samMemberId, amount: '8' },
      ],
    });

    const detail = (await onlyEntry('expense.edited')).detail as Record<string, unknown>;
    expect(detail.amountMinor).toEqual({ from: '1000', to: '2000' });
    expect(detail.payers).toEqual({
      from: [{ memberId: ownerMemberId, amountMinor: '1000' }],
      to: [
        { memberId: ownerMemberId, amountMinor: '1200' },
        { memberId: samMemberId, amountMinor: '800' },
      ],
    });
    // The members did not change, so the participant list is not in the detail.
    expect(detail.participants).toBeUndefined();
  });

  it('leaves the rows and the balances untouched when an unchanged form is saved again (AC-6)', async () => {
    const { owner, groupId, ownerMemberId, samMemberId, devMemberId } = await groupWithThree();

    // 1001 between three does not divide: the whole remainder goes to the first participant in
    // canonical order, and an untouched save has to give it to the same member again.
    await recordAs(owner.cookies, {
      groupId,
      description: 'Groceries',
      amount: '10.01',
      participants: [ownerMemberId, samMemberId, devMemberId],
      payers: [{ memberId: ownerMemberId, amount: '10.01' }],
    });
    const expense = await onlyExpense();

    const before = await childRows();
    const balancesBefore = await balances();

    const result = await editAs(owner.cookies, {
      groupId,
      expenseId: expense.id,
      description: 'Groceries',
      amount: '10.01',
      participants: [ownerMemberId, samMemberId, devMemberId],
      payers: [{ memberId: ownerMemberId, amount: '10.01' }],
    });
    expect(result.ok).toBe(true);

    expect(await childRows()).toEqual(before);
    expect(await balances()).toEqual(balancesBefore);
    // The entry is still written — the save happened — and it claims nothing.
    expect((await onlyEntry('expense.edited')).detail).toEqual({});
  });

  it('refuses the write and rolls back when the feed entry cannot be written', async () => {
    const { owner, groupId, ownerMemberId } = await groupWithThree();

    await recordAs(owner.cookies, {
      groupId,
      description: 'Dinner',
      amount: '10',
      participants: [ownerMemberId],
      payers: [{ memberId: ownerMemberId, amount: '10' }],
    });
    const expense = await onlyExpense();
    const before = await childRows();

    feed.fail = true;
    await expect(
      editAs(owner.cookies, {
        groupId,
        expenseId: expense.id,
        description: 'Supper',
        amount: '20',
        participants: [ownerMemberId],
        payers: [{ memberId: ownerMemberId, amount: '20' }],
      }),
    ).rejects.toThrow('the feed write failed');

    // The parent row, the child rows and the balances are exactly what they were: the edit and
    // its entry are one unit (TR-17).
    expect((await onlyExpense()).description).toBe('Dinner');
    expect((await onlyExpense()).amountMinor).toBe(1000n);
    expect(await childRows()).toEqual(before);
  });
});

describe('members who have left since the expense was recorded', () => {
  it('reopens them in their place, with their name, still checked and still paying (AC-3)', async () => {
    const { owner, groupId, ownerMemberId, samMemberId, devMemberId } = await groupWithThree();

    await recordAs(owner.cookies, {
      groupId,
      description: 'Dinner',
      amount: '10',
      participants: [ownerMemberId, samMemberId, devMemberId],
      payers: [
        { memberId: samMemberId, amount: '4' },
        { memberId: ownerMemberId, amount: '6' },
      ],
    });
    const expense = await onlyExpense();

    await db.update(members).set({ removedAt: new Date() }).where(eq(members.id, samMemberId));

    const reopened = await readExpenseForEdit(db, groupId, expense.id, owner.id);
    // Sam is still there, in canonical order (owner, then created_at), with the name the row is
    // stored under. Dropping him would silently restate everybody else's balance.
    expect(reopened?.members.map((member) => member.displayName)).toEqual(['Priya', 'Sam', 'Dev']);
    expect(reopened?.participants.map((row) => row.memberId)).toEqual([
      ownerMemberId,
      samMemberId,
      devMemberId,
    ]);
    expect(reopened?.payers.map((row) => row.memberId)).toEqual([ownerMemberId, samMemberId]);

    // And the untouched save goes through: the update path validates against the active members
    // UNION the ones this expense already names, so its own stored split is not "unknown".
    const result = await editAs(owner.cookies, {
      groupId,
      expenseId: expense.id,
      description: 'Dinner',
      amount: '10',
      participants: [ownerMemberId, samMemberId, devMemberId],
      payers: [
        { memberId: samMemberId, amount: '4' },
        { memberId: ownerMemberId, amount: '6' },
      ],
    });
    expect(result).toEqual({ ok: true, groupId });

    const shares = await db.select().from(expenseShare);
    expect(new Map(shares.map((row) => [row.memberId, row.amountMinor]))).toEqual(
      new Map([
        [ownerMemberId, 334n],
        [samMemberId, 333n],
        [devMemberId, 333n],
      ]),
    );
  });

  it('reopens in the canonical order extended to them, so the remainder recipient is stable', async () => {
    const { owner, groupId, samMemberId, devMemberId } = await groupWithThree();

    // 1001 between Sam and Dev, Sam first in canonical order, so Sam takes the odd unit.
    await recordAs(owner.cookies, {
      groupId,
      amount: '10.01',
      participants: [samMemberId, devMemberId],
      payers: [{ memberId: samMemberId, amount: '10.01' }],
    });
    const expense = await onlyExpense();

    await db.update(members).set({ removedAt: new Date() }).where(eq(members.id, samMemberId));

    const reopened = await readExpenseForEdit(db, groupId, expense.id, owner.id);
    // Owner, then Sam (created 01-01) before Dev (created 01-02). Appending the departed member at
    // the END would put Dev first and hand him the odd unit — two balances moving on a save that
    // changed nothing.
    expect(reopened?.participants.map((row) => row.memberId)).toEqual([samMemberId, devMemberId]);

    const result = await editAs(owner.cookies, {
      groupId,
      expenseId: expense.id,
      amount: '10.01',
      participants: [samMemberId, devMemberId],
      payers: [{ memberId: samMemberId, amount: '10.01' }],
    });
    expect(result.ok).toBe(true);

    const shares = await db.select().from(expenseShare);
    expect(new Map(shares.map((row) => [row.memberId, row.amountMinor]))).toEqual(
      new Map([
        [samMemberId, 501n],
        [devMemberId, 500n],
      ]),
    );
  });
});

describe('what an edit will not do', () => {
  it('refuses an expense that has been deleted, rather than reopening it', async () => {
    const { owner, groupId, ownerMemberId } = await groupWithThree();

    await recordAs(owner.cookies, {
      groupId,
      amount: '10',
      participants: [ownerMemberId],
      payers: [{ memberId: ownerMemberId, amount: '10' }],
    });
    const expense = await onlyExpense();
    await deleteAs(owner.cookies, groupId, expense.id);

    const result = await editAs(owner.cookies, {
      groupId,
      expenseId: expense.id,
      amount: '20',
      participants: [ownerMemberId],
      payers: [{ memberId: ownerMemberId, amount: '20' }],
    });

    expect(result).toEqual({ ok: false, formError: 'That expense is no longer available.' });
    expect((await onlyExpense()).amountMinor).toBe(1000n);
    expect(await entriesOf('expense.edited')).toHaveLength(0);
  });

  it('refuses a save from somebody who has left the group, with the not-available answer', async () => {
    const { owner, sam, groupId, ownerMemberId, samMemberId } = await groupWithThree();

    await recordAs(owner.cookies, {
      groupId,
      amount: '10',
      participants: [ownerMemberId, samMemberId],
      payers: [{ memberId: ownerMemberId, amount: '10' }],
    });
    const expense = await onlyExpense();

    await db.update(members).set({ removedAt: new Date() }).where(eq(members.id, samMemberId));

    const result = await editAs(sam.cookies, {
      groupId,
      expenseId: expense.id,
      amount: '20',
      participants: [ownerMemberId, samMemberId],
      payers: [{ memberId: ownerMemberId, amount: '20' }],
    });

    // The same sentence a missing group gets: neither may leak which one it was (TR-1).
    expect(result).toEqual({ ok: false, formError: 'That group is not available.' });
    expect((await onlyExpense()).amountMinor).toBe(1000n);
  });

  it('refuses an edit in an archived group, leaving the expense as it was', async () => {
    const { owner, groupId, ownerMemberId } = await groupWithThree();

    await recordAs(owner.cookies, {
      groupId,
      amount: '10',
      participants: [ownerMemberId],
      payers: [{ memberId: ownerMemberId, amount: '10' }],
    });
    const expense = await onlyExpense();

    // The archive action itself is a later piece's; what matters here is that a group that is
    // archived is read-only for spending.
    await db.execute(sql`update groups set archived_at = now()`);

    const result = await editAs(owner.cookies, {
      groupId,
      expenseId: expense.id,
      amount: '20',
      participants: [ownerMemberId],
      payers: [{ memberId: ownerMemberId, amount: '20' }],
    });

    expect(result).toEqual({ ok: false, formError: 'That group is not available.' });
    expect((await onlyExpense()).amountMinor).toBe(1000n);
  });

  it('refuses an empty picker with the create path’s own sentence', async () => {
    const { owner, groupId, ownerMemberId } = await groupWithThree();

    await recordAs(owner.cookies, {
      groupId,
      amount: '10',
      participants: [ownerMemberId],
      payers: [{ memberId: ownerMemberId, amount: '10' }],
    });
    const expense = await onlyExpense();

    const result = await editAs(owner.cookies, {
      groupId,
      expenseId: expense.id,
      amount: '10',
      participants: [],
      payers: [{ memberId: ownerMemberId, amount: '10' }],
    });

    expect(result.ok).toBe(false);
    expect(result.fieldErrors?.participants).toBe(
      'Choose at least one member to split this expense between.',
    );
    expect(await entriesOf('expense.edited')).toHaveLength(0);
  });

  it('refuses a member who is neither in the group nor named by the expense', async () => {
    const { owner, groupId, ownerMemberId } = await groupWithThree();

    await recordAs(owner.cookies, {
      groupId,
      amount: '10',
      participants: [ownerMemberId],
      payers: [{ memberId: ownerMemberId, amount: '10' }],
    });
    const expense = await onlyExpense();

    const result = await editAs(owner.cookies, {
      groupId,
      expenseId: expense.id,
      amount: '10',
      participants: [ownerMemberId, randomUUID()],
      payers: [{ memberId: ownerMemberId, amount: '10' }],
    });

    expect(result.formError).toBe(
      'Somebody in this expense is no longer in this group. Reload the page and try again.',
    );
  });
});

describe('deleting an expense', () => {
  it('removes all three child row sets, marks the row deleted and restores the balances (AC-7)', async () => {
    const { owner, sam, groupId, ownerMemberId, samMemberId, devMemberId } = await groupWithThree();

    await recordAs(owner.cookies, {
      groupId,
      description: 'Taxi',
      amount: '10',
      participants: [ownerMemberId, samMemberId],
      payers: [{ memberId: ownerMemberId, amount: '10' }],
    });
    const expense = await onlyExpense();
    expect(await balances()).toEqual({
      [ownerMemberId]: '500',
      [samMemberId]: '-500',
      // Dev is not in this one, and reads as settled rather than as absent.
      [devMemberId]: '0',
    });

    // Any member may delete, not just the owner and not just whoever recorded it.
    const result = await deleteAs(sam.cookies, groupId, expense.id);
    expect(result).toEqual({ ok: true, groupId });

    // The child rows are gone, which IS the balance being restored: a balance is a sum over them.
    expect(await db.select().from(expensePayer)).toHaveLength(0);
    expect(await db.select().from(expenseShare)).toHaveLength(0);
    expect(await db.select().from(expenseSplitInput)).toHaveLength(0);
    expect(await balances()).toEqual({
      [ownerMemberId]: '0',
      [samMemberId]: '0',
      [devMemberId]: '0',
    });

    // The parent row stays, marked: the feed entry below names the expense it is about.
    expect((await onlyExpense()).deletedAt).toBeInstanceOf(Date);

    expect((await onlyEntry('expense.deleted')).detail).toEqual({
      description: 'Taxi',
      amountMinor: '1000',
      currency: 'EUR',
    });
  });

  it('answers a second delete the same way and writes nothing', async () => {
    const { owner, groupId, ownerMemberId } = await groupWithThree();

    await recordAs(owner.cookies, {
      groupId,
      amount: '10',
      participants: [ownerMemberId],
      payers: [{ memberId: ownerMemberId, amount: '10' }],
    });
    const expense = await onlyExpense();

    const first = await deleteAs(owner.cookies, groupId, expense.id);
    const second = await deleteAs(owner.cookies, groupId, expense.id);

    // A double submit on a slow connection must not report a failure for work that was done.
    expect(first).toEqual({ ok: true, groupId });
    expect(second).toEqual({ ok: true, groupId });
    // And it must not write a second entry: the ledger moved once (TR-17).
    expect(await entriesOf('expense.deleted')).toHaveLength(1);
  });

  it('refuses a delete in an archived group and leaves the expense live', async () => {
    const { owner, groupId, ownerMemberId } = await groupWithThree();

    await recordAs(owner.cookies, {
      groupId,
      amount: '10',
      participants: [ownerMemberId],
      payers: [{ memberId: ownerMemberId, amount: '10' }],
    });
    const expense = await onlyExpense();

    await db.execute(sql`update groups set archived_at = now()`);

    const result = await deleteAs(owner.cookies, groupId, expense.id);
    expect(result).toEqual({ ok: false, formError: 'That group is not available.' });
    expect((await onlyExpense()).deletedAt).toBeNull();
    expect(await entriesOf('expense.deleted')).toHaveLength(0);
  });

  it('refuses a non-member with the same sentence a missing group gets', async () => {
    const { owner, groupId, ownerMemberId } = await groupWithThree();
    const stranger = await seedUser('stranger@example.invalid', 'Sam');

    await recordAs(owner.cookies, {
      groupId,
      amount: '10',
      participants: [ownerMemberId],
      payers: [{ memberId: ownerMemberId, amount: '10' }],
    });
    const expense = await onlyExpense();

    const result = await deleteAs(stranger.cookies, groupId, expense.id);
    expect(result).toEqual({ ok: false, formError: 'That group is not available.' });
    expect((await onlyExpense()).deletedAt).toBeNull();
  });
});

describe('stored history is never re-derived', () => {
  it('leaves another expense’s rows and balances alone when one expense’s rule changes (AC-8)', async () => {
    const { owner, groupId, ownerMemberId, samMemberId, devMemberId } = await groupWithThree();

    // The one that will be edited, and the one that must not move.
    await recordAs(owner.cookies, {
      groupId,
      description: 'Dinner',
      amount: '9',
      participants: [ownerMemberId, samMemberId, devMemberId],
      payers: [{ memberId: ownerMemberId, amount: '9' }],
    });
    await recordAs(owner.cookies, {
      groupId,
      description: 'Groceries',
      amount: '10',
      splitType: 'shares',
      participants: [ownerMemberId, samMemberId, devMemberId],
      inputs: { [ownerMemberId]: '1', [samMemberId]: '1', [devMemberId]: '1' },
      payers: [{ memberId: ownerMemberId, amount: '10' }],
    });

    const rows = await db.select().from(expenses).orderBy(expenses.description);
    const [dinner, groceries] = rows;
    if (!dinner || !groceries) throw new Error('the setup wrote two expenses');
    const before = await childRows();

    // Rewrite the dinner as a percentage split, which is a different division entirely.
    await editAs(owner.cookies, {
      groupId,
      expenseId: dinner.id,
      description: 'Dinner',
      amount: '9',
      splitType: 'percentage',
      participants: [ownerMemberId, samMemberId, devMemberId],
      inputs: { [ownerMemberId]: '50', [samMemberId]: '25', [devMemberId]: '25' },
      payers: [{ memberId: ownerMemberId, amount: '9' }],
    });

    // The other expense's rows are byte-identical: an edit rewrites one expense and never
    // re-evaluates a rule against anything already stored (TR-4).
    const after = await childRows();
    const of = <T extends { expenseId: string }>(rows: T[]) =>
      rows.filter((row) => row.expenseId === groceries.id);
    expect(of(after.payers)).toEqual(of(before.payers));
    expect(of(after.shares)).toEqual(of(before.shares));
    expect(of(after.inputs)).toEqual(of(before.inputs));

    // And the numbers: Groceries is still 334/333/333 of 1000, whatever the dinner now says,
    // while the dinner really did move — 50/25/25 of 900 rather than a third each.
    expect((await db.select().from(expenseShare)).filter((row) => row.expenseId === groceries.id)
      .map((row) => row.amountMinor)
      .sort()).toEqual([333n, 333n, 334n]);
    const dinnerShares = await db.select().from(expenseShare).where(eq(expenseShare.expenseId, dinner.id));
    expect(new Map(dinnerShares.map((row) => [row.memberId, row.amountMinor]))).toEqual(
      new Map([
        [ownerMemberId, 450n],
        [samMemberId, 225n],
        [devMemberId, 225n],
      ]),
    );
  });
});

describe('reopening a stored expense as text', () => {
  it('round-trips a grouped amount, a percentage and a share count back to what was typed (AC-1, AC-2)', async () => {
    const { owner, groupId, ownerMemberId, samMemberId } = await groupWithThree();

    await recordAs(owner.cookies, {
      groupId,
      amount: '1234.56',
      splitType: 'percentage',
      participants: [ownerMemberId, samMemberId],
      inputs: { [ownerMemberId]: '33.33', [samMemberId]: '66.67' },
      payers: [{ memberId: ownerMemberId, amount: '1234.56' }],
    });
    const expense = await onlyExpense();

    const reopened = await readExpenseForEdit(db, groupId, expense.id, owner.id);
    expect(reopened).not.toBeNull();
    expect(formatMajorUnits(reopened!.amountMinor, reopened!.currency)).toBe('1234.56');
    const percentages = new Map(
      reopened!.participants.map((row) => [
        row.memberId,
        formatSplitInput(reopened!.splitType, row.inputValue, reopened!.currency),
      ]),
    );
    // Hundredths of a percent, rendered as the number that was typed rather than as a fraction.
    expect(percentages.get(ownerMemberId)).toBe('33.33');
    expect(percentages.get(samMemberId)).toBe('66.67');

    // And the text parses back to the same minor units, which is what an untouched save does.
    expect(formatMajorUnits(reopened!.payers[0].amountMinor, reopened!.currency)).toBe('1234.56');
  });

  it('renders a currency with no decimal places as whole units', async () => {
    const owner = await seedUser('owner@example.invalid', 'Priya');
    const created = await withRequest(owner.cookies, () =>
      createGroup(null, form({ name: 'Tokyo', currency: 'JPY', type: 'trip' })),
    );
    if (!created.ok || !created.groupId) throw new Error('createGroup refused');
    const groupId = created.groupId;
    const [ownerRow] = await db.select().from(members).where(eq(members.groupId, groupId));

    await recordAs(owner.cookies, {
      groupId,
      amount: '1234',
      splitType: 'exact',
      participants: [ownerRow.id],
      inputs: { [ownerRow.id]: '1234' },
      payers: [{ memberId: ownerRow.id, amount: '1234' }],
    });
    const expense = await onlyExpense();

    const reopened = await readExpenseForEdit(db, groupId, expense.id, owner.id);
    // '¥1,234' would not parse at all; '1234' is what the field has to hold.
    expect(formatMajorUnits(reopened!.amountMinor, 'JPY')).toBe('1234');
    expect(
      formatSplitInput(reopened!.splitType, reopened!.participants[0].inputValue, 'JPY'),
    ).toBe('1234');
  });

  it('renders a share count as the plain count that was entered', async () => {
    const { owner, groupId, ownerMemberId, samMemberId } = await groupWithThree();

    await recordAs(owner.cookies, {
      groupId,
      amount: '10',
      splitType: 'shares',
      participants: [ownerMemberId, samMemberId],
      inputs: { [ownerMemberId]: '2', [samMemberId]: '3' },
      payers: [{ memberId: ownerMemberId, amount: '10' }],
    });
    const expense = await onlyExpense();

    const reopened = await readExpenseForEdit(db, groupId, expense.id, owner.id);
    expect(reopened?.splitType).toBe('shares');
    expect(reopened?.participants.map((row) => row.inputValue)).toEqual([2n, 3n]);
    // A share count is a plain count in whatever currency: '2' and '3', not '2.00' and not money.
    expect(
      reopened?.participants.map((row) =>
        formatSplitInput(reopened.splitType, row.inputValue, reopened.currency),
      ),
    ).toEqual(['2', '3']);
  });
});
