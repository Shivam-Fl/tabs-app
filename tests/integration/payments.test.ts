import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeTestDatabase, useTestDatabase } from '../helpers/pglite';
import { TestCookieStore, form, withRequest } from '../helpers/request';
import type { Database } from '@/db/client';
import { activity, members, payments, sessions, users } from '@/db/schema';
import { createExpense } from '@/app/actions/expenses';
import { archiveGroup, createGroup } from '@/app/actions/groups';
import { leaveGroup } from '@/app/actions/members';
import { deletePayment, recordPayment } from '@/app/actions/payments';
import { listGroupsForUser, readBalancesForGroup, readPaymentsForGroup } from '@/lib/access';
import { SETTLE_FIRST_MESSAGE, simplifyDebts } from '@/lib/balances';
import { SESSION_COOKIE, hashPassword, hashToken, newSessionToken } from '@/lib/auth';

/**
 * The whole write path for a settlement, against a real schema on a real (in-process) Postgres
 * (TR-7).
 *
 * The group these tests work in is seeded with one genuine debt: Priya paid €10.00 that Sam owes
 * all of, so the balances start at +1000 / -1000 and every assertion below about a payment moving
 * a balance by exactly its amount is about a figure that was not zero to begin with.
 *
 * The atomicity cases use the same switch the expenses, groups and members suites do:
 * `recordActivity` is the LAST write of the mutation, so making it throw is how "the payment and
 * its feed entry are one unit" is asserted from outside rather than by reading the transaction
 * body and agreeing with it.
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
 * A group with an owner and two members, whose memberships are ordered ON PURPOSE, for the reason
 * the expenses suite gives: two memberships written in the same instant would fall back to a
 * random uuid for their order, and every "in canonical order" assertion would be a coin toss.
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

  return { owner, sam, dev, groupId, ownerMemberId: ownerRow.id, samMemberId, devMemberId };
}

/** The debt every test below settles against: Priya paid €10.00, Sam owes all of it. */
async function seedDebt(input: {
  cookies: TestCookieStore;
  groupId: string;
  creditorMemberId: string;
  debtorMemberId: string;
}) {
  const data = new FormData();
  data.append('groupId', input.groupId);
  data.append('description', 'Dinner');
  data.append('amount', '10');
  data.append('date', '2026-01-01');
  data.append('category', '');
  data.append('note', '');
  data.append('splitType', 'equal');
  data.append('participant', input.debtorMemberId);
  data.append('payer', input.creditorMemberId);
  data.append(`payerAmount.${input.creditorMemberId}`, '10');

  const result = await withRequest(input.cookies, () => createExpense(null, data));
  if (!result.ok) throw new Error(`createExpense refused: ${JSON.stringify(result)}`);
}

/** The FormData the payment form posts, built the way the form builds it. */
interface PaymentInput {
  groupId: string;
  from?: string;
  to?: string;
  amount?: string;
  note?: string;
}

function paymentForm(values: PaymentInput): FormData {
  const data = new FormData();
  data.append('groupId', values.groupId);
  data.append('from', values.from ?? '');
  data.append('to', values.to ?? '');
  data.append('amount', values.amount ?? '');
  data.append('note', values.note ?? '');
  return data;
}

async function recordAs(cookies: TestCookieStore, values: PaymentInput) {
  return await withRequest(cookies, () => recordPayment(null, paymentForm(values)));
}

async function deleteAs(cookies: TestCookieStore, groupId: string, paymentId: string) {
  return await withRequest(cookies, () => deletePayment(null, form({ groupId, paymentId })));
}

/** Every member's net as the balances screen reads it, keyed by membership row. */
async function netsOf(groupId: string, userId: string): Promise<Map<string, bigint>> {
  const balances = await readBalancesForGroup(db, groupId, userId);
  if (!balances) throw new Error('the caller is not a member of this group');
  return new Map(balances.members.map((member) => [member.memberId, member.balanceMinor]));
}

/** The transfers the balances screen renders for those nets (TR-6). */
async function transfersOf(groupId: string, userId: string) {
  const balances = await readBalancesForGroup(db, groupId, userId);
  if (!balances) throw new Error('the caller is not a member of this group');
  return simplifyDebts(balances.members);
}

async function paymentRows() {
  return await db.select().from(payments);
}

async function entriesOfKind(kind: 'payment.recorded' | 'payment.deleted') {
  return await db.select().from(activity).where(eq(activity.kind, kind));
}

describe('recording a payment', () => {
  it('partial payment moves both balances by exactly its amount and recomputes transfers', async () => {
    const { owner, sam, groupId, ownerMemberId, samMemberId } = await groupWithThree();
    await seedDebt({ cookies: owner.cookies, groupId, creditorMemberId: ownerMemberId, debtorMemberId: samMemberId });

    // The debt before anything is paid: Priya is owed €10.00 and Sam owes it.
    const before = await netsOf(groupId, owner.id);
    expect(before.get(ownerMemberId)).toBe(1000n);
    expect(before.get(samMemberId)).toBe(-1000n);

    const result = await recordAs(sam.cookies, {
      groupId,
      from: samMemberId,
      to: ownerMemberId,
      amount: '4',
      note: 'first part',
    });
    expect(result).toEqual({ ok: true, groupId });

    // The partial payment leaves the remainder owed: 4.00 of 10.00 is paid, 6.00 is not.
    const after = await netsOf(groupId, owner.id);
    expect(after.get(ownerMemberId)).toBe(600n);
    expect(after.get(samMemberId)).toBe(-600n);

    const [payment] = await paymentRows();
    expect(payment?.amountMinor).toBe(400n);
    expect(payment?.fromMemberId).toBe(samMemberId);
    expect(payment?.toMemberId).toBe(ownerMemberId);
    expect(payment?.note).toBe('first part');
    expect(payment?.recordedBy).toBe(sam.id);
    expect(payment?.deletedAt).toBeNull();

    // The transfer list is recomputed from the new balances rather than adjusted (TR-6), which
    // only works because the ledger still sums to zero.
    expect(await transfersOf(groupId, owner.id)).toEqual([
      { fromMemberId: samMemberId, toMemberId: ownerMemberId, amountMinor: 600n },
    ]);
    expect(before.get(ownerMemberId)! + before.get(samMemberId)!).toBe(0n);
  });

  it('record writes exactly one payment.recorded entry with actor, timestamp, subjectType payment, subjectId and detail {fromMemberId, toMemberId, amountMinor as string, note}', async () => {
    const { owner, sam, groupId, ownerMemberId, samMemberId } = await groupWithThree();
    await seedDebt({ cookies: owner.cookies, groupId, creditorMemberId: ownerMemberId, debtorMemberId: samMemberId });

    await recordAs(sam.cookies, {
      groupId,
      from: samMemberId,
      to: ownerMemberId,
      amount: '4',
      note: 'first part',
    });

    const [payment] = await paymentRows();
    const entries = await entriesOfKind('payment.recorded');
    expect(entries).toHaveLength(1);

    const entry = entries[0];
    expect(entry?.actorId).toBe(sam.id);
    expect(entry?.createdAt).toBeInstanceOf(Date);
    expect(entry?.subjectType).toBe('payment');
    expect(entry?.subjectId).toBe(payment?.id);
    // 4.00 is 400 minor units, and the detail carries it as a STRING: jsonb numbers are floats,
    // and a money value is the one thing this column must never turn one into.
    expect(entry?.detail).toEqual({
      fromMemberId: samMemberId,
      toMemberId: ownerMemberId,
      amountMinor: '400',
      note: 'first part',
    });

    // One entry of this kind and no other payment kind: the write is a payment, its row and its
    // one entry, with the group's creation and the debt as the feed's only other contents.
    const all = await db.select().from(activity).where(eq(activity.groupId, groupId));
    expect(all.map((row) => row.kind).sort()).toEqual(['expense.added', 'group.created', 'payment.recorded']);
  });

  it('stores a blank note as null rather than an empty string', async () => {
    const { owner, groupId, ownerMemberId, samMemberId } = await groupWithThree();
    await seedDebt({ cookies: owner.cookies, groupId, creditorMemberId: ownerMemberId, debtorMemberId: samMemberId });

    await recordAs(owner.cookies, {
      groupId,
      from: samMemberId,
      to: ownerMemberId,
      amount: '10',
      note: '   ',
    });

    const [payment] = await paymentRows();
    expect(payment?.note).toBeNull();
    expect((await entriesOfKind('payment.recorded'))[0]?.detail).toMatchObject({ note: null });
  });

  it('lets an active member who is neither end record it, naming two people the group contains', async () => {
    const { owner, dev, groupId, ownerMemberId, samMemberId, devMemberId } = await groupWithThree();

    // Dev is neither the payer nor the payee: recording is open to any active member (TR-7), and
    // the two people named have to be members of this group, which these are.
    const result = await recordAs(dev.cookies, {
      groupId,
      from: ownerMemberId,
      to: samMemberId,
      amount: '2.50',
    });
    expect(result).toEqual({ ok: true, groupId });

    // The payer's net rises and the payee's falls, by the amount: Dev is neither, so their own
    // net is untouched by a payment they recorded.
    const after = await netsOf(groupId, owner.id);
    expect(after.get(ownerMemberId)).toBe(250n);
    expect(after.get(samMemberId)).toBe(-250n);
    expect(after.get(devMemberId)).toBe(0n);
    expect((await paymentRows())[0]?.recordedBy).toBe(dev.id);
  });
});

describe('what a payment is refused for', () => {
  it('validation: non-member from/to refused with fieldErrors on from/to, zero/negative amount refused, from==to refused, archived group refused', async () => {
    const { owner, sam, groupId, ownerMemberId, samMemberId } = await groupWithThree();
    await seedDebt({ cookies: owner.cookies, groupId, creditorMemberId: ownerMemberId, debtorMemberId: samMemberId });
    const stranger = randomUUID();

    // A from or a to that is not an active member of this group: the sentence lands on the field
    // that caused it, so the person is told which control to change.
    const unknownFrom = await recordAs(owner.cookies, { groupId, from: stranger, to: samMemberId, amount: '4' });
    expect(unknownFrom.ok).toBe(false);
    expect(unknownFrom.fieldErrors?.from).toBe('That member is no longer in this group.');

    const unknownTo = await recordAs(owner.cookies, { groupId, from: ownerMemberId, to: stranger, amount: '4' });
    expect(unknownTo.ok).toBe(false);
    expect(unknownTo.fieldErrors?.to).toBe('That member is no longer in this group.');

    const emptyFrom = await recordAs(owner.cookies, { groupId, from: '', to: samMemberId, amount: '4' });
    expect(emptyFrom.fieldErrors?.from).toBe('Choose who paid.');

    // A zero or negative amount is not a payment: it moves no money while still writing a row.
    const zero = await recordAs(owner.cookies, { groupId, from: samMemberId, to: ownerMemberId, amount: '0' });
    expect(zero.ok).toBe(false);
    expect(zero.fieldErrors?.amount).toBe('Enter an amount greater than zero.');

    const negative = await recordAs(owner.cookies, { groupId, from: samMemberId, to: ownerMemberId, amount: '-4' });
    expect(negative.ok).toBe(false);
    expect(negative.fieldErrors?.amount).toBe('Enter a positive amount, without a sign.');

    // An amount the int8 column cannot hold is refused beside the field rather than raising from
    // the insert, which the form would see as an uncaught 500.
    const huge = await recordAs(owner.cookies, {
      groupId,
      from: samMemberId,
      to: ownerMemberId,
      amount: '92233720368547758.08',
    });
    expect(huge.ok).toBe(false);
    expect(huge.fieldErrors?.amount).toBe('That amount is too large to record.');

    // Somebody paying themselves moves money nowhere.
    const sameBothEnds = await recordAs(owner.cookies, {
      groupId,
      from: ownerMemberId,
      to: ownerMemberId,
      amount: '4',
    });
    expect(sameBothEnds.ok).toBe(false);
    expect(sameBothEnds.fieldErrors?.to).toBe('Choose two different members.');

    // Every one of those was refused before anything was written.
    expect(await paymentRows()).toHaveLength(0);
    expect(await entriesOfKind('payment.recorded')).toHaveLength(0);

    // An archived group's history is closed: a settlement written into it would restate it.
    const archived = await withRequest(owner.cookies, () => archiveGroup(null, form({ groupId })));
    expect(archived.ok).toBe(true);
    const afterArchive = await recordAs(sam.cookies, { groupId, from: samMemberId, to: ownerMemberId, amount: '4' });
    expect(afterArchive).toEqual({ ok: false, formError: 'That group is not available.' });
    expect(await paymentRows()).toHaveLength(0);
  });

  it('refuses a caller who is not a member, with the same sentence a missing group gets', async () => {
    const { groupId, ownerMemberId, samMemberId } = await groupWithThree();
    const outsider = await seedUser('outsider@example.invalid', 'Outsider');

    const result = await recordAs(outsider.cookies, {
      groupId,
      from: samMemberId,
      to: ownerMemberId,
      amount: '4',
    });

    // TR-1: one sentence, no rows, and nothing about whether the group even exists.
    expect(result.ok).toBe(false);
    expect(result.formError).toBe('That group is not available.');
    expect(await paymentRows()).toHaveLength(0);
  });
});

describe('deleting a payment', () => {
  it('delete by an involved member restores both balances exactly; second delete is success with no second entry', async () => {
    const { owner, sam, groupId, ownerMemberId, samMemberId } = await groupWithThree();
    await seedDebt({ cookies: owner.cookies, groupId, creditorMemberId: ownerMemberId, debtorMemberId: samMemberId });
    await recordAs(sam.cookies, { groupId, from: samMemberId, to: ownerMemberId, amount: '4', note: 'first part' });
    const [payment] = await paymentRows();

    // Deleted by the RECIPIENT, which is the half of TR-7 that is not the person who typed it.
    const result = await deleteAs(owner.cookies, groupId, payment.id);
    expect(result).toEqual({ ok: true, groupId });

    const restored = await netsOf(groupId, owner.id);
    expect(restored.get(ownerMemberId)).toBe(1000n);
    expect(restored.get(samMemberId)).toBe(-1000n);
    expect(await transfersOf(groupId, owner.id)).toEqual([
      { fromMemberId: samMemberId, toMemberId: ownerMemberId, amountMinor: 1000n },
    ]);

    // Soft-deleted: the row keeps its place, filtered out of every read, so the feed entry that
    // names it still resolves.
    const [after] = await paymentRows();
    expect(after?.deletedAt).toBeInstanceOf(Date);
    expect(await readPaymentsForGroup(db, groupId, owner.id)).toEqual([]);

    const entries = await entriesOfKind('payment.deleted');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.actorId).toBe(owner.id);
    expect(entries[0]?.subjectType).toBe('payment');
    expect(entries[0]?.subjectId).toBe(payment.id);
    expect(entries[0]?.detail).toEqual({
      fromMemberId: samMemberId,
      toMemberId: ownerMemberId,
      amountMinor: '400',
      note: 'first part',
    });

    // A second delete is SUCCESS and writes no second entry: the payment IS deleted, and
    // reporting a failure for work that was done is the bug that half of the criterion is about.
    const second = await deleteAs(owner.cookies, groupId, payment.id);
    expect(second).toEqual({ ok: true, groupId });
    expect(await entriesOfKind('payment.deleted')).toHaveLength(1);

    // And the balances stand where the first delete left them.
    const nets = await netsOf(groupId, owner.id);
    expect(nets.get(ownerMemberId)).toBe(1000n);
    expect(nets.get(samMemberId)).toBe(-1000n);
  });

  it('lets the payer delete it too', async () => {
    const { owner, sam, groupId, ownerMemberId, samMemberId } = await groupWithThree();
    await seedDebt({ cookies: owner.cookies, groupId, creditorMemberId: ownerMemberId, debtorMemberId: samMemberId });
    await recordAs(sam.cookies, { groupId, from: samMemberId, to: ownerMemberId, amount: '10' });
    const [payment] = await paymentRows();

    const result = await deleteAs(sam.cookies, groupId, payment.id);
    expect(result.ok).toBe(true);

    const restored = await netsOf(groupId, owner.id);
    expect(restored.get(ownerMemberId)).toBe(1000n);
    expect(restored.get(samMemberId)).toBe(-1000n);
  });

  it('third member is refused the delete with nothing written', async () => {
    const { owner, sam, dev, groupId, ownerMemberId, samMemberId } = await groupWithThree();
    await seedDebt({ cookies: owner.cookies, groupId, creditorMemberId: ownerMemberId, debtorMemberId: samMemberId });
    await recordAs(sam.cookies, { groupId, from: samMemberId, to: ownerMemberId, amount: '4' });
    const [payment] = await paymentRows();

    const result = await deleteAs(dev.cookies, groupId, payment.id);

    expect(result.ok).toBe(false);
    expect(result.formError).toBe('That payment is no longer available.');
    expect(result.fieldErrors).toBeUndefined();

    const [after] = await paymentRows();
    expect(after?.deletedAt).toBeNull();
    expect(await entriesOfKind('payment.deleted')).toHaveLength(0);
    const nets = await netsOf(groupId, owner.id);
    expect(nets.get(ownerMemberId)).toBe(600n);
    expect(nets.get(samMemberId)).toBe(-600n);
  });

  it('refuses somebody outside the group, and answers a real and an invented id alike', async () => {
    const { owner, sam, groupId, ownerMemberId, samMemberId } = await groupWithThree();
    await seedDebt({ cookies: owner.cookies, groupId, creditorMemberId: ownerMemberId, debtorMemberId: samMemberId });
    await recordAs(sam.cookies, { groupId, from: samMemberId, to: ownerMemberId, amount: '4' });
    const [payment] = await paymentRows();
    const outsider = await seedUser('outsider@example.invalid', 'Outsider');

    const real = await deleteAs(outsider.cookies, groupId, payment.id);
    const invented = await deleteAs(outsider.cookies, groupId, randomUUID());

    // The same answer for a payment they cannot see and one that does not exist: a refusal must
    // not be a way to find out whether an id is real.
    expect(real).toEqual(invented);
    expect(real.ok).toBe(false);
    expect((await paymentRows())[0]?.deletedAt).toBeNull();
  });
});

describe('atomicity', () => {
  it('atomicity: mocked recordActivity throwing leaves no payment row and no entry; one successful write leaves exactly one entry', async () => {
    const { owner, sam, groupId, ownerMemberId, samMemberId } = await groupWithThree();
    await seedDebt({ cookies: owner.cookies, groupId, creditorMemberId: ownerMemberId, debtorMemberId: samMemberId });

    // The failure is a throw out of the transaction body, which is what rolls the whole unit
    // back — so this is asserted as a rejection rather than as a refusal the form would render.
    feed.fail = true;
    await expect(
      recordAs(sam.cookies, { groupId, from: samMemberId, to: ownerMemberId, amount: '4' }),
    ).rejects.toThrow('the feed write failed');

    expect(await paymentRows()).toHaveLength(0);
    expect(await entriesOfKind('payment.recorded')).toHaveLength(0);

    // And the balances never moved, because the row that would have moved them was rolled back.
    const nets = await netsOf(groupId, owner.id);
    expect(nets.get(ownerMemberId)).toBe(1000n);
    expect(nets.get(samMemberId)).toBe(-1000n);

    feed.fail = false;
    const result = await recordAs(sam.cookies, { groupId, from: samMemberId, to: ownerMemberId, amount: '4' });

    expect(result.ok).toBe(true);
    expect(await paymentRows()).toHaveLength(1);
    expect(await entriesOfKind('payment.recorded')).toHaveLength(1);
  });

  it('leaves a payment standing when the feed write of its deletion fails', async () => {
    const { owner, sam, groupId, ownerMemberId, samMemberId } = await groupWithThree();
    await seedDebt({ cookies: owner.cookies, groupId, creditorMemberId: ownerMemberId, debtorMemberId: samMemberId });
    await recordAs(sam.cookies, { groupId, from: samMemberId, to: ownerMemberId, amount: '4' });
    const [payment] = await paymentRows();

    feed.fail = true;
    await expect(deleteAs(owner.cookies, groupId, payment.id)).rejects.toThrow('the feed write failed');

    expect((await paymentRows())[0]?.deletedAt).toBeNull();
    expect(await entriesOfKind('payment.deleted')).toHaveLength(0);
    // Still counting, because the write that would have stopped it did not happen.
    const nets = await netsOf(groupId, owner.id);
    expect(nets.get(ownerMemberId)).toBe(600n);
  });
});

describe('what the rest of the product reads', () => {
  it('leave/remove guard sees payment-adjusted balance', async () => {
    const { owner, sam, groupId, ownerMemberId, samMemberId } = await groupWithThree();
    await seedDebt({ cookies: owner.cookies, groupId, creditorMemberId: ownerMemberId, debtorMemberId: samMemberId });

    // One balance definition: the guard that refuses a leave reads the same figure the screen
    // renders, so a debt can be settled by recording payments and nothing else.
    const stillOwes = await withRequest(sam.cookies, () => leaveGroup(null, form({ groupId })));
    expect(stillOwes).toEqual({ ok: false, formError: SETTLE_FIRST_MESSAGE });

    await recordAs(sam.cookies, { groupId, from: samMemberId, to: ownerMemberId, amount: '4' });
    const partlyPaid = await withRequest(sam.cookies, () => leaveGroup(null, form({ groupId })));
    expect(partlyPaid).toEqual({ ok: false, formError: SETTLE_FIRST_MESSAGE });

    await recordAs(sam.cookies, { groupId, from: samMemberId, to: ownerMemberId, amount: '6' });
    const settled = await withRequest(sam.cookies, () => leaveGroup(null, form({ groupId })));
    expect(settled).toEqual({ ok: true, groupId });

    const [samRow] = await db.select().from(members).where(eq(members.id, samMemberId));
    expect(samRow?.removedAt).toBeInstanceOf(Date);
  });

  it('has no payments for a non-member, and both names for a member', async () => {
    const { owner, sam, groupId, ownerMemberId, samMemberId } = await groupWithThree();
    await recordAs(sam.cookies, { groupId, from: samMemberId, to: ownerMemberId, amount: '4', note: 'first part' });
    const outsider = await seedUser('outsider@example.invalid', 'Outsider');

    const rows = await readPaymentsForGroup(db, groupId, owner.id);
    expect(rows).toHaveLength(1);
    expect(rows?.[0]).toMatchObject({
      fromMemberId: samMemberId,
      fromName: 'Sam',
      toMemberId: ownerMemberId,
      toName: 'Priya',
      amountMinor: 400n,
      note: 'first part',
    });

    expect(await readPaymentsForGroup(db, groupId, outsider.id)).toBeNull();
    // A group id that names nothing is not a way past the membership read either.
    expect(await readPaymentsForGroup(db, randomUUID(), owner.id)).toBeNull();
  });

  it('makes the home list’s per-group figure the one the balances screen shows (TR-8)', async () => {
    const { owner, sam, groupId, ownerMemberId, samMemberId } = await groupWithThree();
    await seedDebt({ cookies: owner.cookies, groupId, creditorMemberId: ownerMemberId, debtorMemberId: samMemberId });
    await recordAs(sam.cookies, { groupId, from: samMemberId, to: ownerMemberId, amount: '4' });

    // The home list sums the caller's own membership row in each group, so it has to apply the
    // same payment adjustment the balances screen does or the two screens disagree about the
    // same debt.
    const priyaHome = await listGroupsForUser(db, owner.id);
    const samHome = await listGroupsForUser(db, sam.id);
    expect(priyaHome.find((entry) => entry.id === groupId)?.balanceMinor).toBe(600n);
    expect(samHome.find((entry) => entry.id === groupId)?.balanceMinor).toBe(-600n);

    // And both equal the figure the group's own screen reads for that member.
    const balances = await readBalancesForGroup(db, groupId, owner.id);
    expect(balances?.members.find((member) => member.memberId === ownerMemberId)?.balanceMinor).toBe(600n);
    expect(balances?.members.find((member) => member.memberId === samMemberId)?.balanceMinor).toBe(-600n);

    // Deleting it puts both back, on both surfaces.
    const [payment] = await paymentRows();
    await deleteAs(owner.cookies, groupId, payment.id);
    expect((await listGroupsForUser(db, owner.id)).find((entry) => entry.id === groupId)?.balanceMinor).toBe(1000n);
    expect((await listGroupsForUser(db, sam.id)).find((entry) => entry.id === groupId)?.balanceMinor).toBe(-1000n);
  });

  it('lists the newest payment first', async () => {
    const { owner, sam, groupId, ownerMemberId, samMemberId } = await groupWithThree();
    await recordAs(sam.cookies, { groupId, from: samMemberId, to: ownerMemberId, amount: '1', note: 'first' });
    await recordAs(sam.cookies, { groupId, from: samMemberId, to: ownerMemberId, amount: '2', note: 'second' });

    const rows = await readPaymentsForGroup(db, groupId, owner.id);
    expect(rows?.map((row) => row.note)).toEqual(['second', 'first']);
  });

  it('stops counting a payment the moment it is deleted (TR-4)', async () => {
    const { owner, sam, groupId, ownerMemberId, samMemberId } = await groupWithThree();
    await seedDebt({ cookies: owner.cookies, groupId, creditorMemberId: ownerMemberId, debtorMemberId: samMemberId });
    await recordAs(sam.cookies, { groupId, from: samMemberId, to: ownerMemberId, amount: '4' });
    const [payment] = await paymentRows();

    await deleteAs(owner.cookies, groupId, payment.id);

    // The balance is the sum of stored rows, and a soft-deleted row is not one of them.
    const nets = await netsOf(groupId, owner.id);
    expect(nets.get(ownerMemberId)).toBe(1000n);
    expect(nets.get(samMemberId)).toBe(-1000n);
  });
});
