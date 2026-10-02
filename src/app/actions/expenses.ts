'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { database } from '@/db/client';
import { expenseCategories, expenseSplitTypes, type ExpenseCategory, type ExpenseSplitType } from '@/db/schema';
import { recordActivity } from '@/lib/activity';
import {
  createExpenseWithRows,
  readDeletedExpenseDescription,
  readExpenseForEdit,
  readGroup,
  readMembers,
  replaceExpenseRows,
  softDeleteExpense,
  type ExpenseContent,
  type ExpenseForEdit,
} from '@/lib/access';
import { requireUser } from '@/lib/auth';
import { formatMinor, parseDecimal, parseMajorUnits, parsePercent, split, splitRefusalMessage } from '@/lib/money';

/**
 * Recording, editing and deleting an expense.
 *
 * Same shape as groups.ts and members.ts: a typed result the form renders, never a throw for an
 * expected failure, and never a redirect from inside the transaction body. Everything below the
 * authorisation read happens in ONE transaction, so an expense is written with its payer rows,
 * its share rows, its entered rule and exactly one feed entry, or none of them is written.
 *
 * All three writes share ONE field-level validation, parameterised by the members the submission
 * may name. That parameter is the whole difference between them: a new expense is checked against
 * the group's ACTIVE members, because that is who the form offered, while an edit is checked
 * against the active members UNION everybody the expense already refers to — otherwise reopening
 * an expense that a member has since left would refuse its own stored split (TR-16).
 *
 * The split is resolved here, before the write, by the same `split()` the form's live summary
 * calls — so what a person was shown and what the server stored come from one implementation,
 * and the row-level sum assertion in access.ts is the check that they did.
 */

export interface ExpenseResult {
  ok: boolean;
  fieldErrors?: Record<string, string>;
  formError?: string;
  /** Set on success: the group whose list the client navigates back to. */
  groupId?: string;
}

const MAX_DESCRIPTION = 200;
const MAX_NOTE = 500;

/**
 * The largest value the int8 columns hold: amount_minor on expenses and on expense_payer, and
 * input_value on expense_split_input. The parsers read anything — parseDecimal builds the whole
 * part with BigInt rather than a float — so without this bound an oversized figure reaches the insert
 * and Postgres raises out-of-range, which the form sees as an uncaught 500 instead of a sentence
 * beside the field that caused it.
 */
const MAX_INT8 = 9223372036854775807n;

const rawSchema = z.object({
  groupId: z.string(),
  description: z.string(),
  amount: z.string(),
  date: z.string(),
  category: z.string(),
  note: z.string(),
  splitType: z.string(),
  participants: z.array(z.string()),
  payers: z.array(z.string()),
  /** memberId -> what that member was given, for the three split types that take a number. */
  inputs: z.record(z.string(), z.string()),
  /** memberId -> what that payer paid. */
  payerAmounts: z.record(z.string(), z.string()),
});

type RawExpense = z.infer<typeof rawSchema>;

const groupIdSchema = z.string().uuid();
const expenseIdSchema = z.string().uuid();

/** `2026-02-30` matches the shape and is not a date; the calendar is the only judge of that. */
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

function isCalendarDate(value: string): boolean {
  if (!DATE_SHAPE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
  );
}

/** A FormData value as a string. A missing field and a file both read as empty. */
function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

function strings(formData: FormData, name: string): string[] {
  return formData.getAll(name).filter((value): value is string => typeof value === 'string');
}

type Parse =
  | { ok: true; value: bigint }
  | { ok: false; message: string };

/** What the transaction body hands back: either it wrote, or it is refused with the sentences. */
type WriteOutcome =
  | { ok: true }
  | { ok: false; fieldErrors?: Record<string, string>; formError?: string };

/** A submission that has been checked: the rows to write, or the sentences that refused it. */
type Validated =
  | { ok: true; value: ExpenseContent }
  | { ok: false; fieldErrors?: Record<string, string>; formError?: string };

/** The refusal a caller gets when they may not see the group, or the expense, any more. */
const GROUP_UNAVAILABLE = 'That group is not available.';
const EXPENSE_UNAVAILABLE = 'That expense is no longer available.';

/**
 * The number a member was given for this split, in the unit the split type counts in: minor
 * units for `exact`, hundredths of a percent for `percentage`, a plain count for `shares`.
 *
 * Blank reads as zero — a member left empty takes no part of the expense — so the check that
 * catches it is the split's own sum, which names the shortfall in the unit it is short in,
 * rather than a per-field "this is not a number" on a field the person deliberately left empty.
 */
function parseMemberInput(type: ExpenseSplitType, raw: string, currency: string): Parse {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: true, value: 0n };

  const parsed =
    type === 'exact'
      ? parseMajorUnits(trimmed, currency)
      : type === 'percentage'
        ? parsePercent(trimmed)
        : parseDecimal(trimmed, 0);

  return parsed.ok ? { ok: true, value: parsed.minor } : { ok: false, message: parsed.message };
}

/**
 * The repeated `participant` and `payer` fields and the `input.<memberId>` / `payerAmount.<memberId>`
 * names, read out of the FormData the way the form writes them. Null when the submission is not
 * this form at all, which the caller answers with a form-level sentence rather than a crash.
 */
function readForm(formData: FormData): RawExpense | null {
  const participantIds = strings(formData, 'participant');
  const payerIds = strings(formData, 'payer');

  const inputs: Record<string, string> = {};
  for (const memberId of participantIds) inputs[memberId] = text(formData, `input.${memberId}`);
  const payerAmounts: Record<string, string> = {};
  for (const memberId of payerIds) payerAmounts[memberId] = text(formData, `payerAmount.${memberId}`);

  const raw = rawSchema.safeParse({
    groupId: text(formData, 'groupId'),
    description: text(formData, 'description'),
    amount: text(formData, 'amount'),
    date: text(formData, 'date'),
    category: text(formData, 'category'),
    note: text(formData, 'note'),
    splitType: text(formData, 'splitType'),
    participants: participantIds,
    payers: payerIds,
    inputs,
    payerAmounts,
  });

  return raw.success ? raw.data : null;
}

/**
 * Checks one submission against the members it may name, and resolves it into the rows to write.
 *
 * `members` is both the set of ids a submission may name and the ORDER everything is resolved in,
 * which is the canonical member order the remainder rule is defined against (TR-3). Create passes
 * the group's active members; update passes the active ones plus everybody that expense already
 * refers to, so a member who has left is still a member this expense may name (TR-16, AC-3).
 */
function validateExpense(input: {
  raw: RawExpense;
  splitType: ExpenseSplitType;
  members: { memberId: string; displayName: string }[];
  currency: string;
}): Validated {
  const { raw, splitType, members, currency } = input;

  const fieldErrors: Record<string, string> = {};
  const byId = new Map(members.map((member) => [member.memberId, member]));
  const nameOf = (memberId: string) => byId.get(memberId)?.displayName ?? 'That member';

  // --- what it was for ---------------------------------------------------------------
  const description = raw.description.trim();
  if (description === '') fieldErrors.description = 'Enter what this expense was for.';
  else if (description.length > MAX_DESCRIPTION) {
    fieldErrors.description = `Keep the description under ${MAX_DESCRIPTION} characters.`;
  }

  if (!isCalendarDate(raw.date)) fieldErrors.date = 'Enter the date this happened on.';

  const amount = parseMajorUnits(raw.amount, currency);
  if (!amount.ok) fieldErrors.amount = amount.message;
  else if (amount.minor <= 0n) fieldErrors.amount = 'Enter an amount greater than zero.';
  else if (amount.minor > MAX_INT8) fieldErrors.amount = 'That amount is too large to record.';

  const category: ExpenseCategory | null =
    raw.category === '' ? null : (raw.category as ExpenseCategory);
  if (category !== null && !expenseCategories.includes(category)) {
    fieldErrors.category = 'Choose one of the categories.';
  }

  const note = raw.note.trim() === '' ? null : raw.note.trim();
  if (note !== null && note.length > MAX_NOTE) {
    fieldErrors.note = `Keep the note under ${MAX_NOTE} characters.`;
  }

  // Nothing below can be resolved without a total, so an unreadable amount is answered here
  // with everything found so far rather than half-checking a split against a zero.
  if (!amount.ok) return { ok: false, fieldErrors };

  // --- who is in the split -----------------------------------------------------------
  // Read off the member list in its canonical order, never off the order the form submitted:
  // this is the order the remainder rule is defined against (TR-3).
  const included = members.filter((member) => raw.participants.includes(member.memberId));
  const unknown = [...raw.participants, ...raw.payers].filter((memberId) => !byId.has(memberId));
  if (unknown.length > 0) {
    return {
      ok: false,
      formError: 'Somebody in this expense is no longer in this group. Reload the page and try again.',
    };
  }
  if (included.length === 0) {
    fieldErrors.participants = 'Choose at least one member to split this expense between.';
  }

  // --- who paid ----------------------------------------------------------------------
  if (raw.payers.length === 0) {
    fieldErrors.payers = 'Choose who paid.';
  } else {
    // A duplicate would be a duplicate key on write, which reads as a 500. It is a request
    // the form cannot make, so it is refused by name rather than as a constraint violation.
    const seen = new Set<string>();
    for (const memberId of raw.payers) {
      if (seen.has(memberId)) {
        fieldErrors.payers = `${nameOf(memberId)} is listed twice as a payer.`;
        break;
      }
      seen.add(memberId);
    }
  }

  const payers: { memberId: string; amountMinor: bigint }[] = [];
  if (!fieldErrors.payers) {
    let sum = 0n;
    for (const memberId of raw.payers) {
      const paid = parseMajorUnits(raw.payerAmounts[memberId] ?? '', currency);
      if (!paid.ok) {
        fieldErrors.payers = paid.message;
        break;
      }
      if (paid.minor <= 0n) {
        fieldErrors.payers = `Enter what ${nameOf(memberId)} paid.`;
        break;
      }
      // Read before the sum is taken: a part that cannot be stored is not a part, so the
      // refusal is about that payer rather than about the total being over-paid.
      if (paid.minor > MAX_INT8) {
        fieldErrors.payers = `${nameOf(memberId)}'s part is too large to record.`;
        break;
      }
      payers.push({ memberId, amountMinor: paid.minor });
      sum += paid.minor;
    }

    // Written in canonical order rather than in the order the boxes were ticked. The rows are
    // keyed by member so the order is not stored, but it IS what the edit path diffs against —
    // and a submission that listed the same payers in another order is not a change.
    const position = new Map(members.map((member, index) => [member.memberId, index]));
    payers.sort((a, b) => (position.get(a.memberId) ?? 0) - (position.get(b.memberId) ?? 0));

    if (!fieldErrors.payers && sum !== amount.minor) {
      const gap = sum < amount.minor ? amount.minor - sum : sum - amount.minor;
      fieldErrors.payers = `Payers add up to ${formatMinor(sum, currency)} — ${formatMinor(gap, currency)} ${
        sum < amount.minor ? 'short of' : 'over'
      } the total.`;
    }
  }

  // --- how it splits -----------------------------------------------------------------
  const splitInputs = included.map((member) => {
    if (splitType === 'equal') return { memberId: member.memberId, value: null };
    const parsed = parseMemberInput(splitType, raw.inputs[member.memberId] ?? '', currency);
    if (!parsed.ok) {
      fieldErrors[`input.${member.memberId}`] ??= parsed.message;
      return { memberId: member.memberId, value: 0n };
    }
    // Every non-null input lands in the int8 input_value column exactly as it was typed —
    // minor units for an exact split, hundredths of a percent for a percentage, a plain count
    // for shares — so every one of them carries the same bound as the total and the payer
    // parts, whatever unit the split type counts in. An exact amount and a share count are
    // both refused with the amount sentence (#33); a percentage, which the sum-to-100% check
    // below refuses anyway, keeps the neutral "number".
    if (parsed.value > MAX_INT8) {
      fieldErrors[`input.${member.memberId}`] ??=
        splitType === 'percentage'
          ? 'That number is too large to record.'
          : 'That amount is too large to record.';
      return { memberId: member.memberId, value: 0n };
    }
    return { memberId: member.memberId, value: parsed.value };
  });

  const resolved = split(amount.minor, splitType, splitInputs);
  if (!resolved.ok) {
    fieldErrors.split ??= splitRefusalMessage(resolved.refusal, currency);
  }

  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };

  return {
    ok: true,
    value: {
      description,
      amountMinor: amount.minor,
      splitType,
      category,
      note,
      date: raw.date,
      payers,
      shares: resolved.ok ? resolved.shares : [],
      inputs: splitInputs,
    },
  };
}

/** One payer as the feed records them: the member, and their part as a string of minor units. */
interface PayerDetail {
  memberId: string;
  amountMinor: string;
}

/** One participant as the feed records them: the member, and the number they were given. */
interface ParticipantDetail {
  memberId: string;
  inputValue: string | null;
}

/**
 * The detail an `expense.edited` entry carries: one `{ from, to }` per field that MOVED. The
 * index signature is what lets it be handed to recordActivity as the jsonb blob it is.
 */
interface ExpenseDiff {
  [field: string]: unknown;
  description?: { from: string; to: string };
  amountMinor?: { from: string; to: string };
  date?: { from: string; to: string };
  category?: { from: string | null; to: string | null };
  note?: { from: string | null; to: string | null };
  splitType?: { from: string; to: string };
  payers?: { from: PayerDetail[]; to: PayerDetail[] };
  participants?: { from: ParticipantDetail[]; to: ParticipantDetail[] };
}

/**
 * What an edit changed, field by field, for the feed entry.
 *
 * Only fields that MOVED appear, so a save that changed the amount and nothing else says that and
 * nothing else. An untouched save is therefore an empty object rather than a claim that something
 * happened which did not — and it is still written, because TR-17 is about the mutation having
 * happened, not about it having been interesting (AC-5, AC-6).
 *
 * The two lists are compared in the canonical member order both sides are already in, so a form
 * that submitted the same members in another order is not a change. Every number inside is a
 * STRING: jsonb numbers are floats, and these are money values and percentages.
 */
function expenseDiff(before: ExpenseForEdit, after: ExpenseContent): ExpenseDiff {
  const diff: ExpenseDiff = {};

  if (before.description !== after.description) {
    diff.description = { from: before.description, to: after.description };
  }
  if (before.amountMinor !== after.amountMinor) {
    diff.amountMinor = { from: before.amountMinor.toString(), to: after.amountMinor.toString() };
  }
  if (before.date !== after.date) diff.date = { from: before.date, to: after.date };
  if (before.category !== after.category) diff.category = { from: before.category, to: after.category };
  if (before.note !== after.note) diff.note = { from: before.note, to: after.note };
  if (before.splitType !== after.splitType) diff.splitType = { from: before.splitType, to: after.splitType };

  const payers = (rows: { memberId: string; amountMinor: bigint }[]): PayerDetail[] =>
    rows.map((row) => ({ memberId: row.memberId, amountMinor: row.amountMinor.toString() }));
  if (JSON.stringify(payers(before.payers)) !== JSON.stringify(payers(after.payers))) {
    diff.payers = { from: payers(before.payers), to: payers(after.payers) };
  }

  // Two column names for one thing: the read calls it inputValue, the row to write calls it value.
  const participants = (rows: { memberId: string; value: bigint | null }[]): ParticipantDetail[] =>
    rows.map((row) => ({ memberId: row.memberId, inputValue: row.value?.toString() ?? null }));
  const beforeParticipants = participants(
    before.participants.map((row) => ({ memberId: row.memberId, value: row.inputValue })),
  );
  const afterParticipants = participants(after.inputs);
  if (JSON.stringify(beforeParticipants) !== JSON.stringify(afterParticipants)) {
    diff.participants = { from: beforeParticipants, to: afterParticipants };
  }

  return diff;
}

/**
 * Records an expense for the group its form was rendered for.
 *
 * The refusal a non-member gets is the one a missing group gets, because the two are the same
 * answer to the question "may this caller write here": no rows, one sentence, nothing about
 * whether the group exists (TR-1, AC-16).
 */
export async function createExpense(
  _previous: ExpenseResult | null,
  formData: FormData,
): Promise<ExpenseResult> {
  const raw = readForm(formData);
  if (!raw) return { ok: false, formError: 'That expense could not be read. Try again.' };

  const groupId = groupIdSchema.safeParse(raw.groupId);
  if (!groupId.success) return { ok: false, formError: GROUP_UNAVAILABLE };

  const splitType = z.enum(expenseSplitTypes).safeParse(raw.splitType);
  if (!splitType.success) return { ok: false, fieldErrors: { splitType: 'Choose how this splits.' } };

  const user = await requireUser();
  const db = await database();

  const outcome = await db.transaction(async (tx): Promise<WriteOutcome> => {
    const group = await readGroup(tx, groupId.data, user.id);
    const members = group ? await readMembers(tx, groupId.data, user.id) : null;
    // One refusal for both: a group that does not exist and a group the caller is not in are
    // the same answer, and neither may leak which one it was.
    if (!group || !members) return { ok: false as const, formError: GROUP_UNAVAILABLE };

    const validation = validateExpense({
      raw,
      splitType: splitType.data,
      // The ACTIVE members: a new expense may only name somebody the form offered.
      members,
      currency: group.currency,
    });
    if (!validation.ok) return validation;

    const expenseId = await createExpenseWithRows(tx, {
      groupId: group.id,
      currency: group.currency,
      createdBy: user.id,
      ...validation.value,
    });
    if (!expenseId) return { ok: false as const, formError: GROUP_UNAVAILABLE };

    await recordActivity(tx, {
      groupId: group.id,
      actorId: user.id,
      kind: 'expense.added',
      subjectType: 'expense',
      subjectId: expenseId,
      detail: {
        description: validation.value.description,
        // A string, never a number: jsonb numbers are floats, and this is a money value.
        amountMinor: validation.value.amountMinor.toString(),
        currency: group.currency,
        splitType: splitType.data,
        category: validation.value.category,
        date: validation.value.date,
      },
    });

    return { ok: true as const };
  });

  if (!outcome.ok) {
    return { ok: false, fieldErrors: outcome.fieldErrors, formError: outcome.formError };
  }

  revalidatePath('/', 'layout');
  return { ok: true, groupId: groupId.data };
}

/**
 * Rewrites an expense in place.
 *
 * The rows are replaced rather than adjusted: the stored payer, share and rule rows ARE the
 * ledger (TR-4), so the edit is a rewrite of what was recorded and never a re-evaluation of a
 * rule against history — which is what keeps AC-8 true for the expenses nobody edited.
 *
 * There is deliberately no "nothing changed, so write nothing" shortcut. An untouched save still
 * writes one entry with an empty detail (AC-5, AC-6), because the alternative — the action
 * deciding a mutation did not happen — is a second, quieter rule about when the ledger moved.
 *
 * A caller who has left the group, or whose group has been archived, is refused with the same
 * sentence a missing group gets; an expense that has been deleted since the form was rendered is
 * refused as unavailable rather than reopened.
 */
export async function updateExpense(
  _previous: ExpenseResult | null,
  formData: FormData,
): Promise<ExpenseResult> {
  const raw = readForm(formData);
  if (!raw) return { ok: false, formError: 'That expense could not be read. Try again.' };

  const groupId = groupIdSchema.safeParse(raw.groupId);
  if (!groupId.success) return { ok: false, formError: GROUP_UNAVAILABLE };

  const expenseId = expenseIdSchema.safeParse(text(formData, 'expenseId'));
  if (!expenseId.success) return { ok: false, formError: EXPENSE_UNAVAILABLE };

  const splitType = z.enum(expenseSplitTypes).safeParse(raw.splitType);
  if (!splitType.success) return { ok: false, fieldErrors: { splitType: 'Choose how this splits.' } };

  const user = await requireUser();
  const db = await database();

  const outcome = await db.transaction(async (tx): Promise<WriteOutcome> => {
    const group = await readGroup(tx, groupId.data, user.id);
    // An archived group is read-only: the archive says the spending is finished, and an edit
    // would restate a history somebody has already closed off.
    if (!group || group.archivedAt) return { ok: false as const, formError: GROUP_UNAVAILABLE };

    const existing = await readExpenseForEdit(tx, groupId.data, expenseId.data, user.id);
    if (!existing) return { ok: false as const, formError: EXPENSE_UNAVAILABLE };

    const validation = validateExpense({
      raw,
      splitType: splitType.data,
      // The ACTIVE members UNION everybody this expense already names, so a member who has left
      // since is still a member this expense may name — its own stored split would otherwise be
      // refused as "no longer in this group" (TR-16).
      members: existing.members,
      currency: group.currency,
    });
    if (!validation.ok) return validation;

    const replaced = await replaceExpenseRows(tx, {
      expenseId: existing.id,
      groupId: group.id,
      editedBy: user.id,
      ...validation.value,
    });
    // The guarded UPDATE matched no row: the expense was deleted between the read and the write.
    if (!replaced) return { ok: false as const, formError: EXPENSE_UNAVAILABLE };

    await recordActivity(tx, {
      groupId: group.id,
      actorId: user.id,
      kind: 'expense.edited',
      subjectType: 'expense',
      subjectId: existing.id,
      // Empty when nothing moved, which is the answer an untouched save gets: one entry, and it
      // claims nothing.
      detail: expenseDiff(existing, validation.value),
    });

    return { ok: true as const };
  });

  if (!outcome.ok) {
    return { ok: false, fieldErrors: outcome.fieldErrors, formError: outcome.formError };
  }

  revalidatePath('/', 'layout');
  return { ok: true, groupId: groupId.data };
}

/**
 * Deletes an expense: any member may, after the dialog that names it.
 *
 * The entry is written from the expense as it was read, because it outlives the thing it names —
 * the parent row is soft-deleted and filtered out of every read, so the feed could not otherwise
 * say what was removed.
 *
 * Deleting twice is the same answer as deleting once, and the second time writes nothing: the
 * guarded UPDATE matches no row on the second pass, so there is no second feed entry (AC-7). That
 * is why the already-deleted case is looked up separately rather than answered as unavailable — a
 * double submit on a slow connection must not report a failure for work that was done.
 */
export async function deleteExpense(
  _previous: ExpenseResult | null,
  formData: FormData,
): Promise<ExpenseResult> {
  const groupId = groupIdSchema.safeParse(text(formData, 'groupId'));
  if (!groupId.success) return { ok: false, formError: GROUP_UNAVAILABLE };

  const expenseId = expenseIdSchema.safeParse(text(formData, 'expenseId'));
  if (!expenseId.success) return { ok: false, formError: EXPENSE_UNAVAILABLE };

  const user = await requireUser();
  const db = await database();

  const outcome = await db.transaction(async (tx): Promise<WriteOutcome> => {
    const group = await readGroup(tx, groupId.data, user.id);
    if (!group || group.archivedAt) return { ok: false as const, formError: GROUP_UNAVAILABLE };

    const existing = await readExpenseForEdit(tx, groupId.data, expenseId.data, user.id);
    if (!existing) {
      // Not readable, so it is either already deleted — answer the same as the delete did, with
      // nothing written — or it was never this caller's to see.
      const alreadyDeleted = await readDeletedExpenseDescription(tx, groupId.data, expenseId.data, user.id);
      if (alreadyDeleted !== null) return { ok: true as const };
      return { ok: false as const, formError: EXPENSE_UNAVAILABLE };
    }

    const removed = await softDeleteExpense(tx, groupId.data, expenseId.data, user.id);
    if (!removed) return { ok: false as const, formError: EXPENSE_UNAVAILABLE };

    await recordActivity(tx, {
      groupId: group.id,
      actorId: user.id,
      kind: 'expense.deleted',
      subjectType: 'expense',
      subjectId: existing.id,
      detail: {
        description: existing.description,
        // A string, never a number: the row is gone from every read, and jsonb numbers float.
        amountMinor: existing.amountMinor.toString(),
        currency: existing.currency,
      },
    });

    return { ok: true as const };
  });

  if (!outcome.ok) {
    return { ok: false, fieldErrors: outcome.fieldErrors, formError: outcome.formError };
  }

  revalidatePath('/', 'layout');
  return { ok: true, groupId: groupId.data };
}
