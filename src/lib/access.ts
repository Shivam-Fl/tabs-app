import { randomBytes, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, notInArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import type { Database } from '@/db/client';
import {
  activity,
  expensePayer,
  expenseShare,
  expenseSplitInput,
  expenses,
  groups,
  members,
  payments,
  users,
  type ActivityKind,
  type ExpenseCategory,
  type ExpenseSplitType,
  type GroupType,
} from '@/db/schema';
import type { Tx } from '@/lib/activity';
import { netBalances, type MemberLedger, type NamedBalance } from '@/lib/balances';

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

/**
 * The group's own lifecycle. Excluded from the overview's recent-activity block: a new group's
 * only entries are its creation and, once somebody copies the link, the link's own rotation —
 * neither of which is something that happened in the group.
 */
const GROUP_LIFECYCLE_KINDS = [
  'group.created',
  'group.renamed',
  'group.archived',
  'group.invite_rotated',
  'group.invite_disabled',
] as const;

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
   * No account behind this row: somebody was added by name before they signed up, and a member
   * who has joined can claim it. True exactly while members.user_id is null.
   */
  isPlaceholder: boolean;
  /**
   * What this member paid minus what they were given, summed from expense_payer and
   * expense_share alone (TR-4). Positive is a credit. Read through readNetByMember, so this is
   * the same figure every other screen and the leave and remove guards see.
   */
  balanceMinor: bigint;
}

/** A group's balances as one caller sees them: their own row, and every active member's net. */
export interface GroupBalances {
  /**
   * The caller's own membership row. The balances screen does not need it — every row is
   * labelled with a name and reads in the third person — but the home screen does, because a
   * transfer is only a line on the summary if the caller is one of its two ends.
   */
  viewerMemberId: string;
  /** Every active member's net, in canonical member order. */
  members: NamedBalance[];
}

/** A group's invite link, for a caller who is a member of it. Both fields are the group's own. */
export interface InviteRow {
  token: string;
  enabled: boolean;
}

/**
 * A group an invite token resolves to: the id to send the joiner to and the name to show them.
 * Deliberately nothing else — a bearer token buys the group's name and the right to join it,
 * not its currency, its members or its feed.
 */
export interface JoinableGroup {
  id: string;
  name: string;
}

/** Why a claim was refused. Each maps to one sentence on the members screen. */
export type ClaimRefusal = 'not-a-member' | 'owner' | 'already-claimed' | 'no-longer-available';

export type ClaimResult = { ok: true; memberId: string } | { ok: false; reason: ClaimRefusal };

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

/** One member's part of an expense, as the list renders it: who, and how much of the total. */
export interface ExpensePayerRow {
  memberId: string;
  displayName: string;
  amountMinor: bigint;
}

/**
 * One recorded payment as the balances screen lists it: both ends named, and what moved. The
 * amount is a bigint count of minor units like every other money value (TR-2).
 */
export interface PaymentRow {
  id: string;
  /** The membership row that paid, and the name every screen shows for it. */
  fromMemberId: string;
  fromName: string;
  /** The membership row that was paid. */
  toMemberId: string;
  toName: string;
  amountMinor: bigint;
  note: string | null;
  createdAt: Date;
}

/**
 * A payment as the delete path reads it, live or already deleted.
 *
 * `deletedAt` is the whole reason this read exists rather than reusing readPaymentsForGroup:
 * deleting twice has to answer success without a second feed entry, and the guard that tells the
 * two apart is whether the row the caller may see is still standing.
 */
export interface PaymentForDeletion {
  id: string;
  fromMemberId: string;
  toMemberId: string;
  amountMinor: bigint;
  note: string | null;
  deletedAt: Date | null;
}

/** A row of the expenses list, with the payers already resolved to names. */
export interface ExpenseRow {
  id: string;
  description: string;
  amountMinor: bigint;
  currency: string;
  splitType: ExpenseSplitType;
  category: ExpenseCategory | null;
  note: string | null;
  /** The calendar date it happened on, as `YYYY-MM-DD` — never shifted through a Date. */
  date: string;
  createdAt: Date;
  /** Every member who paid part of it, in the canonical member order. */
  payers: ExpensePayerRow[];
}

/**
 * The parent columns and the three child row sets an expense is written as, whether it is being
 * added or edited. The shares here are the split() the caller already ran; the inputs are the
 * rule it ran it from, kept so the edit form can reopen the expense exactly as it was saved.
 */
export interface ExpenseContent {
  description: string;
  amountMinor: bigint;
  splitType: ExpenseSplitType;
  category: ExpenseCategory | null;
  note: string | null;
  date: string;
  payers: { memberId: string; amountMinor: bigint }[];
  shares: { memberId: string; amountMinor: bigint }[];
  /** The entered rule, one row per included member. Null value for an equal split. */
  inputs: { memberId: string; value: bigint | null }[];
}

/** The rows one NEW expense is written as. */
export interface NewExpense extends ExpenseContent {
  groupId: string;
  currency: string;
  /** The member whose request this is; also who the row records as having created it. */
  createdBy: string;
}

/** The rows an EXISTING expense is rewritten as. The currency it was recorded in is not one of
 *  them: the group's currency does not change, and an edit must not restate what it was in. */
export interface EditExpense extends ExpenseContent {
  expenseId: string;
  groupId: string;
  /** The member whose request this is; the parent-row UPDATE is authorised against them. */
  editedBy: string;
}

/**
 * The rows a new payment is written as: one member handing another an amount, in the group's own
 * currency. No currency is carried — a payment has no amount column of its own to record one in,
 * and the group's currency is fixed at creation.
 */
export interface NewPayment {
  groupId: string;
  fromMemberId: string;
  toMemberId: string;
  amountMinor: bigint;
  note: string | null;
  /** The member whose request this is; where the two members are checked, and what the feed says. */
  recordedBy: string;
}

/** One member the edit form lists: an active one, or one this expense already refers to. */
export interface ExpenseEditMember {
  memberId: string;
  displayName: string;
}

/**
 * The expense as the edit form reopens it: the row, the rule exactly as it was entered, and
 * every member it names. `participants` and `payers` are in `members` order, which is the
 * canonical order the split's remainder rule is defined against (TR-3) — so an untouched re-save
 * splits the same way the original did, even when somebody has left since.
 */
export interface ExpenseForEdit {
  id: string;
  description: string;
  amountMinor: bigint;
  currency: string;
  splitType: ExpenseSplitType;
  category: ExpenseCategory | null;
  note: string | null;
  /** The calendar date it happened on, as `YYYY-MM-DD` — never shifted through a Date. */
  date: string;
  members: ExpenseEditMember[];
  participants: { memberId: string; inputValue: bigint | null }[];
  payers: { memberId: string; amountMinor: bigint }[];
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

/**
 * The predicate that makes a payment write the caller's: an active membership in this group that
 * IS one of the two members the payment names (TR-7 — the only people who may delete a payment
 * are the two it moved money between).
 *
 * It is one predicate rather than "member of the group" plus a comparison in TypeScript, because
 * the comparison needs the caller's membership id and reading that first is the same shape this
 * module refuses everywhere else: a check that can be separated from the write.
 */
function involvedInPayment(groupId: string, userId: string) {
  return sql`exists (select 1 from ${members} where ${members.groupId} = ${groupId} and ${members.userId} = ${userId} and ${members.removedAt} is null and (${members.id} = ${payments.fromMemberId} or ${members.id} = ${payments.toMemberId}))`;
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

/**
 * The group's active members in the CANONICAL member order, with the name every screen shows.
 *
 * Canonical is not this module's invention: it is the order the expense form's participant
 * picker renders and the order the split's remainder rule is defined against (TR-3), so owner
 * first, then by when the membership was created, then by id so two rows written in the same
 * transaction still have an order. The debt algorithm's tie-break is defined on it too, which is
 * why it is one query here rather than an ordering each caller repeats.
 *
 * Null for a caller who is not a member. Both readers below go through it, so "who is in this
 * group" has exactly one answer in the product.
 */
async function readActiveMemberRows(session: Session, groupId: string, userId: string) {
  const membership = await readMembership(session, groupId, userId);
  if (!membership) return null;

  return await session
    .select({
      memberId: members.id,
      profileName: users.displayName,
      storedName: members.displayName,
      userId: members.userId,
      isOwner: members.isOwner,
    })
    .from(members)
    .leftJoin(users, eq(users.id, members.userId))
    .where(and(eq(members.groupId, groupId), isNull(members.removedAt)))
    .orderBy(desc(members.isOwner), asc(members.createdAt), asc(members.id));
}

/**
 * The group's ledger, summed per member: paid minus shared, and nothing else.
 *
 * This is the ONE place expense rows are added up for a balance (TR-4), and it is why the rule
 * is enforced rather than remembered: expense_split_input is not joined here, expense.split_type
 * is not read here, and there is no other function in src/ that sums an expense. A member with
 * no rows at all is absent from the map, which every caller reads as zero.
 *
 * Payments are the ledger's second kind of row (TR-7) and are summed into the same two halves. A
 * payment from A to B is A handing over money and B being given it, so it lands on the same sides
 * an expense's payer and share rows do: A's paid total rises by the amount and B's shared total
 * rises by it. The subtraction stays where it was — netBalances, one function, so the definition
 * of a balance is one definition — and the ledger still sums to zero, which is what lets the
 * settlement algorithm and the sum-to-zero assertion go on reading these rows unchanged.
 *
 * The membership predicate travels inside every statement's WHERE clause like every other read in
 * this module, so a non-member — or a forged group id — gets an empty map rather than a number.
 */
async function readNetByMember(session: Session, groupId: string, userId: string): Promise<Map<string, bigint>> {
  const paid = await session
    .select({
      memberId: expensePayer.memberId,
      totalMinor: sql<string>`sum(${expensePayer.amountMinor})::text`,
    })
    .from(expensePayer)
    .innerJoin(expenses, eq(expenses.id, expensePayer.expenseId))
    .where(and(eq(expenses.groupId, groupId), isNull(expenses.deletedAt), memberOfGroup(groupId, userId)))
    .groupBy(expensePayer.memberId);

  const shared = await session
    .select({
      memberId: expenseShare.memberId,
      totalMinor: sql<string>`sum(${expenseShare.amountMinor})::text`,
    })
    .from(expenseShare)
    .innerJoin(expenses, eq(expenses.id, expenseShare.expenseId))
    .where(and(eq(expenses.groupId, groupId), isNull(expenses.deletedAt), memberOfGroup(groupId, userId)))
    .groupBy(expenseShare.memberId);

  // What each member has handed over in settlements, and what has been handed to them. A deleted
  // payment is not a payment: its rows stop counting the moment deleted_at is set, which is what
  // makes the delete restore both balances.
  const paidOut = await session
    .select({
      memberId: payments.fromMemberId,
      totalMinor: sql<string>`sum(${payments.amountMinor})::text`,
    })
    .from(payments)
    .where(and(eq(payments.groupId, groupId), isNull(payments.deletedAt), memberOfGroup(groupId, userId)))
    .groupBy(payments.fromMemberId);

  const received = await session
    .select({
      memberId: payments.toMemberId,
      totalMinor: sql<string>`sum(${payments.amountMinor})::text`,
    })
    .from(payments)
    .where(and(eq(payments.groupId, groupId), isNull(payments.deletedAt), memberOfGroup(groupId, userId)))
    .groupBy(payments.toMemberId);

  const paidByMember = new Map(paid.map((row) => [row.memberId, BigInt(row.totalMinor)]));
  const sharedByMember = new Map(shared.map((row) => [row.memberId, BigInt(row.totalMinor)]));
  const paidOutByMember = new Map(paidOut.map((row) => [row.memberId, BigInt(row.totalMinor)]));
  const receivedByMember = new Map(received.map((row) => [row.memberId, BigInt(row.totalMinor)]));

  const memberIds = new Set([
    ...paidByMember.keys(),
    ...sharedByMember.keys(),
    ...paidOutByMember.keys(),
    ...receivedByMember.keys(),
  ]);
  const ledger: MemberLedger[] = [...memberIds].map((memberId) => ({
    memberId,
    paidMinor: (paidByMember.get(memberId) ?? 0n) + (paidOutByMember.get(memberId) ?? 0n),
    sharedMinor: (sharedByMember.get(memberId) ?? 0n) + (receivedByMember.get(memberId) ?? 0n),
  }));

  // netBalances does the subtraction, so the definition of a balance is in one function rather
  // than in each read that needs it.
  return new Map(netBalances(ledger).map((balance) => [balance.memberId, balance.balanceMinor]));
}

/** The group's active members, owner first, each with their real balance. Null for a non-member. */
export async function readMembers(session: Session, groupId: string, userId: string): Promise<MemberRow[] | null> {
  const rows = await readActiveMemberRows(session, groupId, userId);
  if (!rows) return null;

  const nets = await readNetByMember(session, groupId, userId);

  return rows.map((row) => ({
    memberId: row.memberId,
    // The live profile first, then the name a placeholder was created with. A claimed
    // placeholder therefore shows the claimer's own name, and the stored one is only ever
    // reached while there is no account behind the row.
    displayName: row.profileName ?? row.storedName ?? 'Member',
    isOwner: row.isOwner,
    isPlaceholder: row.userId === null,
    balanceMinor: nets.get(row.memberId) ?? 0n,
  }));
}

/**
 * Every active member's net balance in the group, in canonical member order, from expense_payer
 * and expense_share alone (TR-4). Null for a caller who is not an active member.
 *
 * The balances screen and the group overview ask this; the members screen asks readMembers,
 * because it also needs each row's role. Both read the same sums through readNetByMember.
 */
export async function readBalancesForGroup(
  session: Session,
  groupId: string,
  userId: string,
): Promise<GroupBalances | null> {
  const membership = await readMembership(session, groupId, userId);
  if (!membership) return null;

  const rows = await readActiveMemberRows(session, groupId, userId);
  if (!rows) return null;

  const nets = await readNetByMember(session, groupId, userId);

  return {
    viewerMemberId: membership.memberId,
    members: rows.map((row) => ({
      memberId: row.memberId,
      displayName: row.profileName ?? row.storedName ?? 'Member',
      balanceMinor: nets.get(row.memberId) ?? 0n,
    })),
  };
}

/**
 * One member's net balance, for the two writes TR-13 gates on it: leaving and being removed.
 *
 * Null for a caller who is not themselves an active member of the group, so a forged request
 * cannot read somebody else's balance — and, more to the point, cannot read it as zero and walk
 * through a guard that is the only thing standing between a settled group and a stranded debt.
 */
export async function readNetBalanceForMember(
  session: Session,
  groupId: string,
  memberId: string,
  userId: string,
): Promise<bigint | null> {
  const membership = await readMembership(session, groupId, userId);
  if (!membership) return null;

  const nets = await readNetByMember(session, groupId, userId);
  return nets.get(memberId) ?? 0n;
}

/**
 * The group's expenses, newest first by the date each happened on and with created_at then id
 * breaking a tie, for a caller who is an active member. Null for everybody else, so a
 * non-member reads nothing rather than an empty list (TR-1).
 *
 * The payers are a second statement rather than a join, because an expense with two payers
 * would otherwise arrive as two rows of the same expense and the list would have to be folded
 * back together — and the fold is where a row gets dropped. Both statements carry the
 * membership predicate, so neither is reachable by a non-member.
 */
export async function readExpensesForGroup(
  session: Session,
  groupId: string,
  userId: string,
): Promise<ExpenseRow[] | null> {
  const membership = await readMembership(session, groupId, userId);
  if (!membership) return null;

  const rows = await session
    .select({
      id: expenses.id,
      description: expenses.description,
      amountMinor: expenses.amountMinor,
      currency: expenses.currency,
      splitType: expenses.splitType,
      category: expenses.category,
      note: expenses.note,
      date: expenses.date,
      createdAt: expenses.createdAt,
    })
    .from(expenses)
    .where(and(eq(expenses.groupId, groupId), isNull(expenses.deletedAt), memberOfGroup(groupId, userId)))
    .orderBy(desc(expenses.date), desc(expenses.createdAt), desc(expenses.id));

  if (rows.length === 0) return [];

  const payerRows = await session
    .select({
      expenseId: expensePayer.expenseId,
      memberId: expensePayer.memberId,
      profileName: users.displayName,
      storedName: members.displayName,
      amountMinor: expensePayer.amountMinor,
    })
    .from(expensePayer)
    .innerJoin(expenses, eq(expenses.id, expensePayer.expenseId))
    .innerJoin(members, eq(members.id, expensePayer.memberId))
    .leftJoin(users, eq(users.id, members.userId))
    .where(and(eq(expenses.groupId, groupId), isNull(expenses.deletedAt), memberOfGroup(groupId, userId)))
    .orderBy(desc(members.isOwner), asc(members.createdAt), asc(members.id));

  const payersByExpense = new Map<string, ExpensePayerRow[]>();
  for (const row of payerRows) {
    const payers = payersByExpense.get(row.expenseId) ?? [];
    payers.push({
      memberId: row.memberId,
      displayName: row.profileName ?? row.storedName ?? 'Member',
      amountMinor: row.amountMinor,
    });
    payersByExpense.set(row.expenseId, payers);
  }

  return rows.map((row) => ({ ...row, payers: payersByExpense.get(row.id) ?? [] }));
}

/**
 * The group's recorded payments, newest first and with both names already resolved, for a caller
 * who is an active member. Null for everybody else, so a non-member reads nothing rather than an
 * empty list (TR-1).
 *
 * Both members are joined as aliases of the same table, because a payment names two membership
 * rows and a single join cannot say which end it matched. Each name is the live profile first and
 * the stored placeholder name second, exactly as every other read resolves a member — so a
 * payment to somebody who has been removed, or to a placeholder nobody has claimed, still reads
 * with the name the group knows them by (TR-16).
 *
 * Deleted payments are filtered out rather than returned flagged: the feed entry is what remembers
 * them, and a screen that lists them would be a second history that could disagree with the
 * balances.
 */
export async function readPaymentsForGroup(
  session: Session,
  groupId: string,
  userId: string,
): Promise<PaymentRow[] | null> {
  const membership = await readMembership(session, groupId, userId);
  if (!membership) return null;

  const fromMember = alias(members, 'payment_from_member');
  const fromUser = alias(users, 'payment_from_user');
  const toMember = alias(members, 'payment_to_member');
  const toUser = alias(users, 'payment_to_user');

  const rows = await session
    .select({
      id: payments.id,
      fromMemberId: payments.fromMemberId,
      fromProfileName: fromUser.displayName,
      fromStoredName: fromMember.displayName,
      toMemberId: payments.toMemberId,
      toProfileName: toUser.displayName,
      toStoredName: toMember.displayName,
      amountMinor: payments.amountMinor,
      note: payments.note,
      createdAt: payments.createdAt,
    })
    .from(payments)
    .innerJoin(fromMember, eq(fromMember.id, payments.fromMemberId))
    .leftJoin(fromUser, eq(fromUser.id, fromMember.userId))
    .innerJoin(toMember, eq(toMember.id, payments.toMemberId))
    .leftJoin(toUser, eq(toUser.id, toMember.userId))
    // The membership predicate is the authorisation, exactly as it is on the expenses list: the
    // real `members` table inside memberOfGroup's subquery is not the aliased join above, so it
    // is the group's membership being asked about and not one of the payment's two ends.
    .where(and(eq(payments.groupId, groupId), isNull(payments.deletedAt), memberOfGroup(groupId, userId)))
    // `id` breaks a tie on the timestamp, which two payments written by the same transaction
    // share: now() is the transaction's start time, not each statement's.
    .orderBy(desc(payments.createdAt), desc(payments.id));

  return rows.map((row) => ({
    id: row.id,
    fromMemberId: row.fromMemberId,
    fromName: row.fromProfileName ?? row.fromStoredName ?? 'Member',
    toMemberId: row.toMemberId,
    toName: row.toProfileName ?? row.toStoredName ?? 'Member',
    amountMinor: row.amountMinor,
    note: row.note,
    createdAt: row.createdAt,
  }));
}

/**
 * One payment, live or already deleted, for a caller who is an active member AND one of the two
 * members it involves. Null for everybody else — a third member included.
 *
 * This is TR-7's delete authorisation as a read, and it is deliberately the same predicate the
 * guarded UPDATE carries (involvedInPayment), so a caller who may see the row to delete it is a
 * caller who may delete it and there is no view a third member gets that the write would refuse.
 * The row comes back whether or not it is deleted, because the action has to tell "already gone"
 * (answer success, write nothing) from "never yours" (refuse).
 */
export async function readPaymentForDeletion(
  session: Session,
  groupId: string,
  paymentId: string,
  userId: string,
): Promise<PaymentForDeletion | null> {
  const rows = await session
    .select({
      id: payments.id,
      fromMemberId: payments.fromMemberId,
      toMemberId: payments.toMemberId,
      amountMinor: payments.amountMinor,
      note: payments.note,
      deletedAt: payments.deletedAt,
    })
    .from(payments)
    .where(
      and(
        eq(payments.id, paymentId),
        eq(payments.groupId, groupId),
        involvedInPayment(groupId, userId),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

/**
 * One expense, with the rule it was saved with and everybody it names, for a caller who is an
 * active member. Null for a non-member, for an expense that is not in this group, and for one
 * that has been deleted — the edit screen must never reopen a deleted row.
 *
 * The member list deliberately reaches FURTHER than readMembers does. readMembers lists active
 * members only, because that is who can be offered for a split; this lists every active member
 * plus every member this expense already refers to as a payer or as a participant, so somebody
 * who has since left the group is still listed, still checked, under the name they are stored
 * with (TR-16: a removal ends a membership, not the history behind it). It is one list rather
 * than two because the form renders one: a departed participant and a departed payer are the
 * same row with the same name.
 *
 * The order is the canonical one extended to those departed members — owner first, then
 * created_at, then id — applied to that whole set rather than appending the departed at the end.
 * That is what makes the reopened order stable: the split's remainder goes to the FIRST
 * participant in this order, so a participant who left and sorts early must still sort early, or
 * an untouched re-save would move the odd minor unit from one member to another and change two
 * balances without anybody editing anything.
 */
export async function readExpenseForEdit(
  session: Session,
  groupId: string,
  expenseId: string,
  userId: string,
): Promise<ExpenseForEdit | null> {
  const membership = await readMembership(session, groupId, userId);
  if (!membership) return null;

  const rows = await session
    .select({
      id: expenses.id,
      description: expenses.description,
      amountMinor: expenses.amountMinor,
      currency: expenses.currency,
      splitType: expenses.splitType,
      category: expenses.category,
      note: expenses.note,
      date: expenses.date,
    })
    .from(expenses)
    .where(
      and(
        eq(expenses.id, expenseId),
        eq(expenses.groupId, groupId),
        isNull(expenses.deletedAt),
        memberOfGroup(groupId, userId),
      ),
    )
    .limit(1);

  const expense = rows[0];
  if (!expense) return null;

  const memberRows = await session
    .select({
      memberId: members.id,
      profileName: users.displayName,
      storedName: members.displayName,
    })
    .from(members)
    .leftJoin(users, eq(users.id, members.userId))
    .where(
      and(
        eq(members.groupId, groupId),
        sql`(${members.removedAt} is null
          or exists (select 1 from ${expensePayer}
            where ${expensePayer.memberId} = ${members.id} and ${expensePayer.expenseId} = ${expenseId}::uuid)
          or exists (select 1 from ${expenseSplitInput}
            where ${expenseSplitInput.memberId} = ${members.id} and ${expenseSplitInput.expenseId} = ${expenseId}::uuid))`,
      ),
    )
    .orderBy(desc(members.isOwner), asc(members.createdAt), asc(members.id));

  const participantRows = await session
    .select({ memberId: expenseSplitInput.memberId, inputValue: expenseSplitInput.inputValue })
    .from(expenseSplitInput)
    .where(eq(expenseSplitInput.expenseId, expenseId));

  const payerRows = await session
    .select({ memberId: expensePayer.memberId, amountMinor: expensePayer.amountMinor })
    .from(expensePayer)
    .where(eq(expensePayer.expenseId, expenseId));

  // Both row sets come back in whatever order the database feels like; the order that matters is
  // the member list's, which is the order the form renders and the server splits in.
  const position = new Map(memberRows.map((row, index) => [row.memberId, index]));
  const inMemberOrder = <T extends { memberId: string }>(items: T[]): T[] =>
    [...items].sort((a, b) => (position.get(a.memberId) ?? 0) - (position.get(b.memberId) ?? 0));

  return {
    ...expense,
    members: memberRows.map((row) => ({
      memberId: row.memberId,
      displayName: row.profileName ?? row.storedName ?? 'Member',
    })),
    participants: inMemberOrder(participantRows),
    payers: inMemberOrder(payerRows),
  };
}

/**
 * The description of an expense the caller has just been told was deleted, or null.
 *
 * The list's confirmation is server-resolved from the id in the URL for the reason the leave
 * notice is: a URL anybody can type must not be able to put words on the screen. Two guards hold
 * that: the row has to be soft-deleted — pasting the id of a live expense makes the list claim
 * nothing — and the caller has to be a member of the group it was in.
 */
export async function readDeletedExpenseDescription(
  session: Session,
  groupId: string,
  expenseId: string,
  userId: string,
): Promise<string | null> {
  const rows = await session
    .select({ description: expenses.description })
    .from(expenses)
    .where(
      and(
        eq(expenses.id, expenseId),
        eq(expenses.groupId, groupId),
        isNotNull(expenses.deletedAt),
        memberOfGroup(groupId, userId),
      ),
    )
    .limit(1);

  return rows[0]?.description ?? null;
}

/**
 * The group's invite token and whether it is live, for a caller who is an active member.
 * Null for everybody else.
 *
 * Member-scoped rather than owner-scoped, because the criterion is that a plain member sees the
 * link and only the owner sees the controls — and member-scoped rather than folded into
 * GroupRow, because the token is a secret that only the members screen has any business
 * rendering, and a field on GroupRow would travel to every screen that reads a group.
 */
export async function readInviteForMember(
  session: Session,
  groupId: string,
  userId: string,
): Promise<InviteRow | null> {
  const rows = await session
    .select({ token: groups.inviteToken, enabled: groups.inviteEnabled })
    .from(groups)
    .innerJoin(members, and(eq(members.groupId, groups.id), eq(members.userId, userId), isNull(members.removedAt)))
    .where(eq(groups.id, groupId))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * The group an invite token names, or null.
 *
 * This is the one read in the product that answers without a session, because the token IS the
 * credential: it resolves only while the link is enabled and the group is not archived, and it
 * carries no join — there is no membership to join against yet. A token that is rotated,
 * disabled, archived or simply wrong resolves to nothing, and the caller is answered with the
 * same 404 as any other unknown URL.
 */
export async function resolveGroupByToken(session: Session, token: string): Promise<JoinableGroup | null> {
  const rows = await session
    .select({ id: groups.id, name: groups.name })
    .from(groups)
    .where(and(eq(groups.inviteToken, token), eq(groups.inviteEnabled, true), isNull(groups.archivedAt)))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * The caller's groups, newest activity first — a group with no activity at all sorts last
 * rather than first, which is what NULLS LAST is for: `DESC` alone would put every group that
 * nothing has ever happened in above the ones something just happened in.
 */
export async function listGroupsForUser(session: Session, userId: string): Promise<GroupSummary[]> {
  const rows = await session
    .select({
      id: groups.id,
      name: groups.name,
      type: groups.type,
      currency: groups.currency,
      // The caller's own membership row in each group, carried so the two sums below can be
      // keyed by it: a caller has exactly one active row per group, so it identifies both.
      memberId: members.id,
    })
    .from(groups)
    .innerJoin(members, and(eq(members.groupId, groups.id), eq(members.userId, userId), isNull(members.removedAt)))
    .leftJoin(activity, eq(activity.groupId, groups.id))
    .where(isNull(groups.archivedAt))
    // members.id is not functionally dependent on the grouped groups.id — it is another table's
    // key — so it has to be named here for Postgres to accept selecting it.
    .groupBy(groups.id, members.id)
    .orderBy(sql`max(${activity.createdAt}) desc nulls last`, desc(groups.createdAt));

  // The caller's own balance in each group, summed from the stored rows exactly as a single
  // group's is (TR-4) — the same rows, the same definition, so a figure here cannot disagree
  // with the figure the group's own screen shows. The join onto their own membership row is
  // also the authorisation: another member's payer and share rows are not reachable from here.
  const paid = await session
    .select({
      memberId: expensePayer.memberId,
      totalMinor: sql<string>`sum(${expensePayer.amountMinor})::text`,
    })
    .from(expensePayer)
    .innerJoin(expenses, eq(expenses.id, expensePayer.expenseId))
    .innerJoin(members, eq(members.id, expensePayer.memberId))
    .where(and(eq(members.userId, userId), isNull(members.removedAt), isNull(expenses.deletedAt)))
    .groupBy(expensePayer.memberId);

  const shared = await session
    .select({
      memberId: expenseShare.memberId,
      totalMinor: sql<string>`sum(${expenseShare.amountMinor})::text`,
    })
    .from(expenseShare)
    .innerJoin(expenses, eq(expenses.id, expenseShare.expenseId))
    .innerJoin(members, eq(members.id, expenseShare.memberId))
    .where(and(eq(members.userId, userId), isNull(members.removedAt), isNull(expenses.deletedAt)))
    .groupBy(expenseShare.memberId);

  // Payments, summed the same way and onto the same two halves as readNetByMember does, so a
  // group's total here equals the balance that group's own screen shows (TR-8). The join onto the
  // caller's own membership row is again the authorisation and again the key: a payment whose
  // either end is somebody else in the group is not reachable from here.
  const paidOut = await session
    .select({
      memberId: payments.fromMemberId,
      totalMinor: sql<string>`sum(${payments.amountMinor})::text`,
    })
    .from(payments)
    .innerJoin(members, eq(members.id, payments.fromMemberId))
    .where(and(eq(members.userId, userId), isNull(members.removedAt), isNull(payments.deletedAt)))
    .groupBy(payments.fromMemberId);

  const received = await session
    .select({
      memberId: payments.toMemberId,
      totalMinor: sql<string>`sum(${payments.amountMinor})::text`,
    })
    .from(payments)
    .innerJoin(members, eq(members.id, payments.toMemberId))
    .where(and(eq(members.userId, userId), isNull(members.removedAt), isNull(payments.deletedAt)))
    .groupBy(payments.toMemberId);

  const paidByMember = new Map(paid.map((row) => [row.memberId, BigInt(row.totalMinor)]));
  const sharedByMember = new Map(shared.map((row) => [row.memberId, BigInt(row.totalMinor)]));
  const paidOutByMember = new Map(paidOut.map((row) => [row.memberId, BigInt(row.totalMinor)]));
  const receivedByMember = new Map(received.map((row) => [row.memberId, BigInt(row.totalMinor)]));
  const ledger: MemberLedger[] = rows.map((row) => ({
    memberId: row.memberId,
    paidMinor: (paidByMember.get(row.memberId) ?? 0n) + (paidOutByMember.get(row.memberId) ?? 0n),
    sharedMinor: (sharedByMember.get(row.memberId) ?? 0n) + (receivedByMember.get(row.memberId) ?? 0n),
  }));
  const balances = new Map(netBalances(ledger).map((balance) => [balance.memberId, balance.balanceMinor]));

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    type: row.type,
    currency: row.currency,
    balanceMinor: balances.get(row.memberId) ?? 0n,
  }));
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

/**
 * Writes one expense and its rows: the rule the person entered (split_type and one
 * expense_split_input per included member), the amounts that rule produced (expense_share),
 * and who actually paid (expense_payer). Returns the new expense's id, or null when the caller
 * is not an active member of the group, in which case nothing was written.
 *
 * The membership predicate travels INSIDE the insert — `insert ... select ... where exists (a
 * membership)` — rather than being a read the caller does first, for the reason the rest of this
 * module gives: a check that can be separated from the write is a check that gets forgotten.
 * The child rows reference the expense id, which exists only if that insert matched.
 *
 * Before it returns — and so before the caller's transaction can commit — the rows actually in
 * the database are summed and asserted against the total (TR-3). Asserting the arrays in
 * memory would only restate what the caller already believed; this reads back what was written.
 */
export async function createExpenseWithRows(tx: Tx, input: NewExpense): Promise<string | null> {
  const expenseId = randomUUID();

  const inserted = await tx.execute<{ id: string }>(sql`
    insert into ${expenses}
      (id, group_id, description, amount_minor, currency, split_type, category, note, date, created_by)
    select
      ${expenseId}::uuid,
      ${input.groupId}::uuid,
      ${input.description},
      ${input.amountMinor.toString()}::bigint,
      ${input.currency},
      ${input.splitType}::expense_split_type,
      ${input.category}::expense_category,
      ${input.note},
      ${input.date}::date,
      ${input.createdBy}::uuid
    where ${memberOfGroup(input.groupId, input.createdBy)}
    returning id
  `);

  if (!inserted.rows[0]) return null;

  await insertExpenseChildRows(tx, expenseId, input);
  await assertExpenseRowsSum(tx, expenseId, input.amountMinor);

  return expenseId;
}

/**
 * Rewrites an existing expense in place: the parent row first, then the three child row sets,
 * all on the caller's transaction and so all with the one feed entry the action writes beside
 * them (TR-4, TR-17).
 *
 * The UPDATE comes FIRST and is what authorises the write, for two reasons. It carries the
 * membership predicate, so a caller who is not an active member matches no row and the child
 * rows below are never reached — the same "the check travels inside the statement" rule the rest
 * of this module keeps. And it takes a row lock on the parent: two saves of one expense arriving
 * together serialize on it, so the second reads rows the first has committed rather than
 * interleaving its delete with the other's insert.
 *
 * Returns false when nothing was updated — not a member, not this group's expense, or deleted —
 * in which case nothing was deleted and nothing was written.
 */
export async function replaceExpenseRows(tx: Tx, input: EditExpense): Promise<boolean> {
  const updated = await tx
    .update(expenses)
    .set({
      description: input.description,
      amountMinor: input.amountMinor,
      splitType: input.splitType,
      category: input.category,
      note: input.note,
      date: input.date,
    })
    .where(
      and(
        eq(expenses.id, input.expenseId),
        eq(expenses.groupId, input.groupId),
        isNull(expenses.deletedAt),
        memberOfGroup(input.groupId, input.editedBy),
      ),
    )
    .returning();

  if (updated.length === 0) return false;

  await deleteExpenseChildRows(tx, input.expenseId);
  await insertExpenseChildRows(tx, input.expenseId, input);
  // Read back out of the database, as the create path does: the assertion is about what was
  // written, not about the arrays the caller believed it was writing.
  await assertExpenseRowsSum(tx, input.expenseId, input.amountMinor);

  return true;
}

/**
 * Deletes an expense: its stored payer, share and rule rows go, and the parent row keeps its
 * place in the table with deleted_at set.
 *
 * Removing the child rows IS restoring the balances. A balance is a sum over expense_payer and
 * expense_share alone (TR-4), so the expense stops counting the moment its rows are gone — which
 * is why the delete cannot be a flag on the parent alone while the ledger rows stayed behind.
 *
 * The guarded UPDATE is the whole of the idempotence: `deleted_at is null` means a second delete
 * of the same expense — a double submit, a second tab — matches no row, so it removes nothing
 * and returns false. The caller answers that the same way it answers the first, and writes no
 * second feed entry (TR-17).
 */
export async function softDeleteExpense(
  tx: Tx,
  groupId: string,
  expenseId: string,
  userId: string,
): Promise<boolean> {
  const deleted = await tx
    .update(expenses)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(expenses.id, expenseId),
        eq(expenses.groupId, groupId),
        isNull(expenses.deletedAt),
        memberOfGroup(groupId, userId),
      ),
    )
    .returning();

  if (deleted.length === 0) return false;

  await deleteExpenseChildRows(tx, expenseId);
  return true;
}

/** The three child row sets of one expense, removed together: what an edit replaces and what a
 *  delete removes. */
async function deleteExpenseChildRows(tx: Tx, expenseId: string): Promise<void> {
  await tx.delete(expensePayer).where(eq(expensePayer.expenseId, expenseId));
  await tx.delete(expenseShare).where(eq(expenseShare.expenseId, expenseId));
  await tx.delete(expenseSplitInput).where(eq(expenseSplitInput.expenseId, expenseId));
}

/** The three child row sets of one expense as they are to be stored. */
async function insertExpenseChildRows(tx: Tx, expenseId: string, rows: ExpenseContent): Promise<void> {
  if (rows.payers.length > 0) {
    await tx.insert(expensePayer).values(rows.payers.map((payer) => ({ expenseId, ...payer })));
  }
  if (rows.shares.length > 0) {
    await tx.insert(expenseShare).values(rows.shares.map((share) => ({ expenseId, ...share })));
  }
  if (rows.inputs.length > 0) {
    await tx.insert(expenseSplitInput).values(
      rows.inputs.map((rule) => ({ expenseId, memberId: rule.memberId, inputValue: rule.value })),
    );
  }
}

/**
 * Sums the rows that are actually in the database and asserts them against the total (TR-3).
 * Asserting the arrays in memory would only restate what the caller already believed.
 */
async function assertExpenseRowsSum(tx: Tx, expenseId: string, totalMinor: bigint): Promise<void> {
  const totals = await tx.execute<{ paid: string; shared: string }>(sql`
    select
      (select coalesce(sum(${expensePayer.amountMinor}), 0)::text from ${expensePayer}
        where ${expensePayer.expenseId} = ${expenseId}::uuid) as paid,
      (select coalesce(sum(${expenseShare.amountMinor}), 0)::text from ${expenseShare}
        where ${expenseShare.expenseId} = ${expenseId}::uuid) as shared
  `);

  const paid = BigInt(totals.rows[0]?.paid ?? '0');
  const shared = BigInt(totals.rows[0]?.shared ?? '0');
  if (paid !== totalMinor || shared !== totalMinor) {
    // A programming error, not a user error: this throws so the transaction rolls back rather
    // than committing an expense whose parts do not add up to its total.
    throw new Error(
      `tabs: expense ${expenseId} was written with payers totalling ${paid} and shares totalling ${shared}, against a total of ${totalMinor}`,
    );
  }
}

/**
 * Records one payment between two members of the group. Returns the new payment's id, or null
 * when the caller is not an active member of the group, in which case nothing was written.
 *
 * The membership predicate travels INSIDE the insert — `insert ... select ... where exists (a
 * membership)` — for the reason the rest of this module gives: a check that can be separated from
 * the write is a check that gets forgotten. The two members the payment names are checked by the
 * action against the group's active member list, read on this same transaction, exactly as an
 * expense's payers and participants are; there is no second place a member could be added from.
 */
export async function createPayment(tx: Tx, input: NewPayment): Promise<string | null> {
  const paymentId = randomUUID();

  const inserted = await tx.execute<{ id: string }>(sql`
    insert into ${payments}
      (id, group_id, from_member_id, to_member_id, amount_minor, note, recorded_by)
    select
      ${paymentId}::uuid,
      ${input.groupId}::uuid,
      ${input.fromMemberId}::uuid,
      ${input.toMemberId}::uuid,
      ${input.amountMinor.toString()}::bigint,
      ${input.note},
      ${input.recordedBy}::uuid
    where ${memberOfGroup(input.groupId, input.recordedBy)}
    returning id
  `);

  return inserted.rows[0]?.id ?? null;
}

/**
 * Deletes a payment: deleted_at is set on the row, which is what stops it counting.
 *
 * A balance is a sum over stored rows, so a payment stops moving money the moment its row is
 * filtered out by every read — which is why the delete is this flag and not a correction written
 * against the balances. The row itself stays, because the payment.recorded entry that named it
 * outlives it and a feed entry pointing at nothing is a feed entry the reader cannot interpret.
 *
 * The guarded UPDATE is the whole of both the authorisation and the idempotence. `deleted_at is
 * null` means a second delete of the same payment — a double submit, a second tab — matches no
 * row, so it removes nothing and returns false, and the caller answers that the same way it
 * answered the first and writes no second feed entry (TR-17). `involvedInPayment` means a third
 * member is not merely refused by a sentence somewhere else: their request reaches no row at all.
 */
export async function softDeletePayment(
  tx: Tx,
  groupId: string,
  paymentId: string,
  userId: string,
): Promise<boolean> {
  const deleted = await tx
    .update(payments)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(payments.id, paymentId),
        eq(payments.groupId, groupId),
        isNull(payments.deletedAt),
        involvedInPayment(groupId, userId),
      ),
    )
    .returning();

  return deleted.length > 0;
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

/**
 * Joins the caller to a group if they are not already in it. Returns the new membership's id,
 * or null when they were already a member and nothing was written.
 *
 * The two inserts here and in addPlaceholderAsOwner are written as `insert ... select ... where
 * not exists` rather than as a read followed by an insert. The predicate travels INSIDE the
 * statement, so there is no window between deciding and writing in which a second confirm of
 * the same link could slip through and create the second active row the partial unique index
 * forbids. It is the same rule the rest of this module keeps — the authorisation is part of the
 * query — applied to the one shape a Drizzle `where` cannot express, which is why these two are
 * the only statements in src/ built from raw SQL. What decides the result is the length of the
 * rows the `returning` clause hands back.
 *
 * The `on conflict` is the backstop the `where not exists` cannot be. Both statements read the
 * same snapshot, so under READ COMMITTED two OVERLAPPING confirms can both pass the predicate —
 * the loser then reaches members_group_user_active_idx with its row already written and raises a
 * unique violation, which the caller surfaces as a 500. Naming that index's own predicate as the
 * conflict target makes the loser take the same empty-`returning` no-op the sequential second
 * confirm already takes, so both racers answer success with exactly one row and one feed entry.
 * The predicate has to match the index exactly: a partial unique index is inferable only when
 * the clause repeats it, and a mismatch raises at runtime instead of doing nothing.
 */
export async function joinGroupIfAbsent(tx: Tx, groupId: string, userId: string): Promise<string | null> {
  const memberId = randomUUID();
  const inserted = await tx.execute<{ id: string }>(sql`
    insert into ${members} (id, group_id, user_id)
    select ${memberId}::uuid, ${groupId}::uuid, ${userId}::uuid
    where not exists (
      select 1 from ${members}
      where group_id = ${groupId}::uuid and user_id = ${userId}::uuid and removed_at is null
    )
    on conflict (group_id, user_id) where user_id is not null and removed_at is null do nothing
    returning id
  `);

  return inserted.rows[0]?.id ?? null;
}

/**
 * Adds a member by name, before they have an account. Owner-only, and the owner check is the
 * `exists` in the select rather than a read the caller then trusts.
 *
 * Returns the new membership's id, or null when the caller does not own the group.
 */
export async function addPlaceholderAsOwner(
  tx: Tx,
  groupId: string,
  name: string,
  userId: string,
): Promise<string | null> {
  const memberId = randomUUID();
  const inserted = await tx.execute<{ id: string }>(sql`
    insert into ${members} (id, group_id, user_id, display_name)
    select ${memberId}::uuid, ${groupId}::uuid, null, ${name}
    where exists (
      select 1 from ${members}
      where group_id = ${groupId}::uuid and user_id = ${userId}::uuid and is_owner and removed_at is null
    )
    returning id
  `);

  return inserted.rows[0]?.id ?? null;
}

/** The one row a claim reads: who is behind it, and whether it is still standing. */
async function readMemberStanding(
  session: Session,
  groupId: string,
  memberId: string,
): Promise<{ userId: string | null; removedAt: Date | null } | null> {
  const rows = await session
    .select({ userId: members.userId, removedAt: members.removedAt })
    .from(members)
    .where(and(eq(members.id, memberId), eq(members.groupId, groupId)))
    .limit(1);

  return rows[0] ?? null;
}

/** Attaches a user to a placeholder row, and only while it is still unclaimed and active. */
export async function attachPlaceholderToUser(
  tx: Tx,
  groupId: string,
  memberId: string,
  userId: string,
): Promise<boolean> {
  const updated = await tx
    .update(members)
    .set({ userId })
    .where(
      and(
        eq(members.id, memberId),
        eq(members.groupId, groupId),
        isNull(members.userId),
        isNull(members.removedAt),
      ),
    )
    .returning();

  return updated.length > 0;
}

/**
 * Claims a placeholder by merging the caller into it: their own membership row is ended and
 * their user_id attaches to the placeholder row, so every share and payer record already
 * pointing at that row becomes theirs without a single one of them being rewritten (TR-15).
 *
 * The order is the whole of the correctness. Ending the caller's own row FIRST is what frees
 * the (group, user) slot the active-membership index would otherwise collide with when the
 * placeholder row becomes active again with their user_id on it. The guarded UPDATE is then the
 * arbiter: whichever claim reaches it first attaches, and the loser matches zero rows. The
 * loser's own row is restored in the same transaction, so a refused claim leaves the caller
 * exactly as they were rather than a member with no membership.
 */
export async function mergeClaimPlaceholder(
  tx: Tx,
  input: { groupId: string; placeholderMemberId: string; caller: Membership },
): Promise<ClaimResult> {
  const { groupId, placeholderMemberId, caller } = input;

  // Before anything is written: claiming ends the caller's own row, and an owner's row is the
  // one the partial unique index holds the ownership slot with. Nothing in this piece can
  // promote a new owner, so an owner's claim would leave a group nobody owns.
  if (caller.isOwner) return { ok: false, reason: 'owner' };

  if (!(await endMembership(tx, caller.memberId, caller.userId))) {
    return { ok: false, reason: 'not-a-member' };
  }

  if (await attachPlaceholderToUser(tx, groupId, placeholderMemberId, caller.userId)) {
    return { ok: true, memberId: placeholderMemberId };
  }

  // The UPDATE matched nothing, so the placeholder was claimed by somebody else, been removed,
  // or was never a placeholder. The caller goes back as they were, and the read below only
  // decides which sentence they are told — it cannot change what the UPDATE decided.
  await restoreMembership(tx, groupId, caller.memberId, caller.userId);

  const standing = await readMemberStanding(tx, groupId, placeholderMemberId);
  return {
    ok: false,
    reason: !standing || standing.removedAt !== null ? 'no-longer-available' : 'already-claimed',
  };
}

/**
 * Makes a new invite link, owner-only, and re-enables it.
 *
 * A new link the owner cannot use would be no link at all, so rotating after disabling turns
 * the link back on: the old token is dead either way, which is the point of rotating.
 */
export async function rotateInviteAsOwner(tx: Tx, groupId: string, userId: string): Promise<string | null> {
  const token = newInviteToken();
  const updated = await tx
    .update(groups)
    .set({ inviteToken: token, inviteEnabled: true })
    .where(and(eq(groups.id, groupId), ownedByCaller(groupId, userId)))
    .returning();

  return updated.length > 0 ? token : null;
}

/** Turns the invite link off (or back on), owner-only. False when the caller does not own it. */
export async function setInviteEnabledAsOwner(
  tx: Tx,
  groupId: string,
  enabled: boolean,
  userId: string,
): Promise<boolean> {
  const updated = await tx
    .update(groups)
    .set({ inviteEnabled: enabled })
    .where(and(eq(groups.id, groupId), ownedByCaller(groupId, userId)))
    .returning();

  return updated.length > 0;
}
