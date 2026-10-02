'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { database } from '@/db/client';
import { expenseCategories, expenseSplitTypes, type ExpenseCategory, type ExpenseSplitType } from '@/db/schema';
import { recordActivity } from '@/lib/activity';
import { createExpenseWithRows, readGroup, readMembers } from '@/lib/access';
import { requireUser } from '@/lib/auth';
import { formatMinor, parseDecimal, parseMajorUnits, parsePercent, split, splitRefusalMessage } from '@/lib/money';

/**
 * Recording an expense.
 *
 * Same shape as groups.ts and members.ts: a typed result the form renders, never a throw for an
 * expected failure, and never a redirect from inside the transaction body. Everything below the
 * authorisation read happens in ONE transaction, so an expense is written with its payer rows,
 * its share rows, its entered rule and exactly one feed entry, or none of them is written.
 *
 * The split is resolved here, before the write, by the same `split()` the form's live summary
 * calls — so what a person was shown and what the server stored come from one implementation,
 * and the row-level sum assertion in createExpenseWithRows is the check that they did.
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

const groupIdSchema = z.string().uuid();

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
  if (!raw.success) return { ok: false, formError: 'That expense could not be read. Try again.' };

  const groupId = groupIdSchema.safeParse(raw.data.groupId);
  if (!groupId.success) return { ok: false, formError: 'That group is not available.' };

  const splitType = z.enum(expenseSplitTypes).safeParse(raw.data.splitType);
  if (!splitType.success) return { ok: false, fieldErrors: { splitType: 'Choose how this splits.' } };

  const user = await requireUser();
  const db = await database();

  const outcome = await db.transaction(async (tx): Promise<WriteOutcome> => {
    const group = await readGroup(tx, groupId.data, user.id);
    const members = group ? await readMembers(tx, groupId.data, user.id) : null;
    // One refusal for both: a group that does not exist and a group the caller is not in are
    // the same answer, and neither may leak which one it was.
    if (!group || !members) return { ok: false as const, formError: 'That group is not available.' };

    const fieldErrors: Record<string, string> = {};
    const byId = new Map(members.map((member) => [member.memberId, member]));
    const nameOf = (memberId: string) => byId.get(memberId)?.displayName ?? 'That member';

    // --- what it was for -------------------------------------------------------------
    const description = raw.data.description.trim();
    if (description === '') fieldErrors.description = 'Enter what this expense was for.';
    else if (description.length > MAX_DESCRIPTION) {
      fieldErrors.description = `Keep the description under ${MAX_DESCRIPTION} characters.`;
    }

    if (!isCalendarDate(raw.data.date)) fieldErrors.date = 'Enter the date this happened on.';

    const amount = parseMajorUnits(raw.data.amount, group.currency);
    if (!amount.ok) fieldErrors.amount = amount.message;
    else if (amount.minor <= 0n) fieldErrors.amount = 'Enter an amount greater than zero.';
    else if (amount.minor > MAX_INT8) fieldErrors.amount = 'That amount is too large to record.';

    const category: ExpenseCategory | null =
      raw.data.category === '' ? null : (raw.data.category as ExpenseCategory);
    if (category !== null && !expenseCategories.includes(category)) {
      fieldErrors.category = 'Choose one of the categories.';
    }

    const note = raw.data.note.trim() === '' ? null : raw.data.note.trim();
    if (note !== null && note.length > MAX_NOTE) {
      fieldErrors.note = `Keep the note under ${MAX_NOTE} characters.`;
    }

    // Nothing below can be resolved without a total, so an unreadable amount is answered here
    // with everything found so far rather than half-checking a split against a zero.
    if (!amount.ok) return { ok: false, fieldErrors };

    // --- who is in the split ---------------------------------------------------------
    // Read off the group's own members in their canonical order, never off the order the form
    // submitted: this is the order the remainder rule is defined against (TR-3).
    const included = members.filter((member) => participantIds.includes(member.memberId));
    const unknown = [...participantIds, ...payerIds].filter((memberId) => !byId.has(memberId));
    if (unknown.length > 0) {
      return {
        ok: false as const,
        formError: 'Somebody in this expense is no longer in this group. Reload the page and try again.',
      };
    }
    if (included.length === 0) {
      fieldErrors.participants = 'Choose at least one member to split this expense between.';
    }

    // --- who paid --------------------------------------------------------------------
    if (payerIds.length === 0) {
      fieldErrors.payers = 'Choose who paid.';
    } else {
      // A duplicate would be a duplicate key on write, which reads as a 500. It is a request
      // the form cannot make, so it is refused by name rather than as a constraint violation.
      const seen = new Set<string>();
      for (const memberId of payerIds) {
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
      for (const memberId of payerIds) {
        const paid = parseMajorUnits(raw.data.payerAmounts[memberId] ?? '', group.currency);
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

      if (!fieldErrors.payers && sum !== amount.minor) {
        const gap = sum < amount.minor ? amount.minor - sum : sum - amount.minor;
        fieldErrors.payers = `Payers add up to ${formatMinor(sum, group.currency)} — ${formatMinor(gap, group.currency)} ${
          sum < amount.minor ? 'short of' : 'over'
        } the total.`;
      }
    }

    // --- how it splits ---------------------------------------------------------------
    const splitInputs = included.map((member) => {
      if (splitType.data === 'equal') return { memberId: member.memberId, value: null };
      const parsed = parseMemberInput(splitType.data, inputs[member.memberId] ?? '', group.currency);
      if (!parsed.ok) {
        fieldErrors[`input.${member.memberId}`] ??= parsed.message;
        return { memberId: member.memberId, value: 0n };
      }
      // Every non-null input lands in the int8 input_value column exactly as it was typed —
      // minor units for an exact split, hundredths of a percent for a percentage, a plain count
      // for shares — so every one of them carries the same bound as the total and the payer
      // parts, whatever unit the split type counts in. The sentence says "amount" only for the
      // exact branch, where the number really is money.
      if (parsed.value > MAX_INT8) {
        fieldErrors[`input.${member.memberId}`] ??=
          splitType.data === 'exact'
            ? 'That amount is too large to record.'
            : 'That number is too large to record.';
        return { memberId: member.memberId, value: 0n };
      }
      return { memberId: member.memberId, value: parsed.value };
    });

    const resolved = split(amount.minor, splitType.data, splitInputs);
    if (!resolved.ok) {
      fieldErrors.split ??= splitRefusalMessage(resolved.refusal, group.currency);
    }

    if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };

    const expenseId = await createExpenseWithRows(tx, {
      groupId: group.id,
      description,
      amountMinor: amount.minor,
      currency: group.currency,
      splitType: splitType.data,
      category,
      note,
      date: raw.data.date,
      createdBy: user.id,
      payers,
      shares: resolved.ok ? resolved.shares : [],
      inputs: splitInputs,
    });
    if (!expenseId) return { ok: false as const, formError: 'That group is not available.' };

    await recordActivity(tx, {
      groupId: group.id,
      actorId: user.id,
      kind: 'expense.added',
      subjectType: 'expense',
      subjectId: expenseId,
      detail: {
        description,
        // A string, never a number: jsonb numbers are floats, and this is a money value.
        amountMinor: amount.minor.toString(),
        currency: group.currency,
        splitType: splitType.data,
        category,
        date: raw.data.date,
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
