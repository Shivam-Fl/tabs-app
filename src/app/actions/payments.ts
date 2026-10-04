'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { database } from '@/db/client';
import { recordActivity } from '@/lib/activity';
import {
  createPayment,
  readGroup,
  readMembers,
  readPaymentForDeletion,
  softDeletePayment,
  type MemberRow,
} from '@/lib/access';
import { requireUser } from '@/lib/auth';
import { parseMajorUnits } from '@/lib/money';

/**
 * Recording and deleting a settlement (TR-7).
 *
 * Same shape as expenses.ts and members.ts: a typed result the form renders, never a throw for an
 * expected failure, and never a redirect from inside a transaction body. Each write is ONE
 * transaction holding the payment row, exactly one feed entry, and nothing else — so a payment and
 * the record of it are the same unit, and a failure anywhere leaves neither (TR-17).
 *
 * Who may do what is decided in two different places on purpose. Recording is open to any active
 * member, and the two members it names are checked against the group's ACTIVE member list read on
 * this transaction — a payment names two people the group still contains. Deleting is open to the
 * two members the payment involves and to nobody else, which is expressed as a predicate inside
 * the read and inside the guarded UPDATE rather than as a comparison here (TR-7).
 */

export interface PaymentResult {
  ok: boolean;
  fieldErrors?: Record<string, string>;
  formError?: string;
  /** Set on success: the group whose balances the client refreshes. */
  groupId?: string;
}

const MAX_NOTE = 500;

/**
 * The largest value the int8 amount_minor column holds. parseMajorUnits reads anything — it builds
 * the whole part with BigInt rather than a float — so without this bound an oversized figure
 * reaches the insert and Postgres raises out-of-range, which the form sees as an uncaught 500
 * instead of a sentence beside the field that caused it.
 */
const MAX_INT8 = 9223372036854775807n;

const groupIdSchema = z.string().uuid();
const paymentIdSchema = z.string().uuid();
const memberIdSchema = z.string().uuid();

/** The refusal a caller gets when they may not write in the group, or may not see the payment. */
const GROUP_UNAVAILABLE = 'That group is not available.';
const PAYMENT_UNAVAILABLE = 'That payment is no longer available.';

/** A FormData value as a string. A missing field and a file both read as empty. */
function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

/** What the transaction body hands back: either it wrote, or it is refused with the sentences. */
type WriteOutcome =
  | { ok: true }
  | { ok: false; fieldErrors?: Record<string, string>; formError?: string };

/** A submission that has been checked: the rows to write, or the sentences that refused it. */
type Validated =
  | {
      ok: true;
      value: { fromMemberId: string; toMemberId: string; amountMinor: bigint; note: string | null };
    }
  | { ok: false; fieldErrors?: Record<string, string>; formError?: string };

/**
 * The detail a payment entry carries, in the one shape both payment kinds use: who paid whom, how
 * much, and the note as it was typed. `amountMinor` is a STRING of minor units — jsonb numbers
 * are floats, and this is a money value, which is the one thing the feed's detail column must
 * never turn one into. Both kinds carry the payment as it was, because a deleted payment's row is
 * still there but filtered out of every read, so the entry is the only thing left that can say
 * what was removed.
 */
function paymentDetail(payment: {
  fromMemberId: string;
  toMemberId: string;
  amountMinor: bigint;
  note: string | null;
}): Record<string, unknown> {
  return {
    fromMemberId: payment.fromMemberId,
    toMemberId: payment.toMemberId,
    amountMinor: payment.amountMinor.toString(),
    note: payment.note,
  };
}

/**
 * Checks one submission against the group's active members and resolves it into the row to write.
 *
 * A blank choice and a choice that is no longer in the group read differently, because they are
 * different things to be told: the first is a form somebody has not filled in, the second is a
 * form rendered before somebody left. Both are refusals with the sentence beside the field that
 * caused them, never a form-level message the person has to map back to a control themselves.
 */
function validatePayment(input: { raw: Record<string, string>; members: MemberRow[]; currency: string }): Validated {
  const { raw, members, currency } = input;

  const fieldErrors: Record<string, string> = {};
  const byId = new Map(members.map((member) => [member.memberId, member]));

  const chosen = (name: 'from' | 'to', nothing: string): string | null => {
    const value = raw[name] ?? '';
    const parsed = memberIdSchema.safeParse(value);
    if (value.trim() === '' || !parsed.success) {
      fieldErrors[name] = nothing;
      return null;
    }
    if (!byId.has(parsed.data)) {
      fieldErrors[name] = 'That member is no longer in this group.';
      return null;
    }
    return parsed.data;
  };

  const fromMemberId = chosen('from', 'Choose who paid.');
  const toMemberId = chosen('to', 'Choose who was paid.');

  // A payment from somebody to themselves moves money nowhere while still writing a row and a
  // feed entry. Refused on the second field rather than the first, because it is the choice in
  // front of the person that has to change.
  if (fromMemberId !== null && fromMemberId === toMemberId) {
    fieldErrors.to = 'Choose two different members.';
  }

  const amount = parseMajorUnits((raw.amount ?? '').trim(), currency);
  if (!amount.ok) fieldErrors.amount = amount.message;
  else if (amount.minor <= 0n) fieldErrors.amount = 'Enter an amount greater than zero.';
  else if (amount.minor > MAX_INT8) fieldErrors.amount = 'That amount is too large to record.';

  const note = (raw.note ?? '').trim() === '' ? null : (raw.note ?? '').trim();
  if (note !== null && note.length > MAX_NOTE) {
    fieldErrors.note = `Keep the note under ${MAX_NOTE} characters.`;
  }

  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };
  if (fromMemberId === null || toMemberId === null || !amount.ok) {
    // Unreachable: every one of those paths set a field error above. Spelled out so the types
    // below are narrowed rather than asserted.
    return { ok: false, formError: PAYMENT_UNAVAILABLE };
  }

  return { ok: true, value: { fromMemberId, toMemberId, amountMinor: amount.minor, note } };
}

/**
 * Records a payment between two members of the group its form was rendered for.
 *
 * The refusal a non-member gets is the one a missing group gets, because the two are the same
 * answer to "may this caller write here": no rows, one sentence, nothing about whether the group
 * exists (TR-1). An archived group is refused with the same sentence for the reason an expense
 * edit is: the archive says the spending is finished, and a settlement written into it would
 * restate a history somebody has closed off.
 */
export async function recordPayment(
  _previous: PaymentResult | null,
  formData: FormData,
): Promise<PaymentResult> {
  const groupId = groupIdSchema.safeParse(text(formData, 'groupId'));
  if (!groupId.success) return { ok: false, formError: GROUP_UNAVAILABLE };

  const user = await requireUser();
  const db = await database();

  const outcome = await db.transaction(async (tx): Promise<WriteOutcome> => {
    const group = await readGroup(tx, groupId.data, user.id);
    if (!group || group.archivedAt) return { ok: false as const, formError: GROUP_UNAVAILABLE };

    const members = await readMembers(tx, groupId.data, user.id);
    if (!members) return { ok: false as const, formError: GROUP_UNAVAILABLE };

    const validation = validatePayment({
      raw: {
        from: text(formData, 'from'),
        to: text(formData, 'to'),
        amount: text(formData, 'amount'),
        note: text(formData, 'note'),
      },
      // The group's ACTIVE members: a payment may only name two people the group still contains.
      members,
      currency: group.currency,
    });
    if (!validation.ok) return validation;

    const paymentId = await createPayment(tx, {
      groupId: group.id,
      fromMemberId: validation.value.fromMemberId,
      toMemberId: validation.value.toMemberId,
      amountMinor: validation.value.amountMinor,
      note: validation.value.note,
      recordedBy: user.id,
    });
    if (!paymentId) return { ok: false as const, formError: GROUP_UNAVAILABLE };

    await recordActivity(tx, {
      groupId: group.id,
      actorId: user.id,
      kind: 'payment.recorded',
      subjectType: 'payment',
      subjectId: paymentId,
      detail: paymentDetail(validation.value),
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
 * Deletes a payment: one of the two members it involves, after the dialog that names it.
 *
 * The entry is written from the payment as it was read, because it outlives the thing it names —
 * the row keeps its place and is filtered out of every read, so the feed could not otherwise say
 * what was removed.
 *
 * Deleting twice is the same answer as deleting once, and the second time writes nothing: the
 * payment is already deleted, which the read says plainly, so the action answers success and
 * writes no second feed entry (TR-17). That is why the already-deleted case is looked up
 * separately rather than answered as unavailable — a double submit on a slow connection must not
 * report a failure for work that was done.
 *
 * A third member is refused by the READ, so their request never reaches the UPDATE: they are
 * answered the same sentence a payment that does not exist gets, and nothing about whether it
 * exists is leaked to them (TR-7).
 */
export async function deletePayment(
  _previous: PaymentResult | null,
  formData: FormData,
): Promise<PaymentResult> {
  const groupId = groupIdSchema.safeParse(text(formData, 'groupId'));
  if (!groupId.success) return { ok: false, formError: GROUP_UNAVAILABLE };

  const paymentId = paymentIdSchema.safeParse(text(formData, 'paymentId'));
  if (!paymentId.success) return { ok: false, formError: PAYMENT_UNAVAILABLE };

  const user = await requireUser();
  const db = await database();

  const outcome = await db.transaction(async (tx): Promise<WriteOutcome> => {
    const group = await readGroup(tx, groupId.data, user.id);
    if (!group || group.archivedAt) return { ok: false as const, formError: GROUP_UNAVAILABLE };

    const existing = await readPaymentForDeletion(tx, groupId.data, paymentId.data, user.id);
    // Not readable by this caller: a third member, somebody outside the group, or an id that
    // names nothing at all. One sentence for all three, so a refusal says nothing about what
    // exists.
    if (!existing) return { ok: false as const, formError: PAYMENT_UNAVAILABLE };
    if (existing.deletedAt !== null) return { ok: true as const };

    const removed = await softDeletePayment(tx, groupId.data, paymentId.data, user.id);
    // The guarded UPDATE matched no row: somebody else deleted it between the read and the write.
    // Answered as unavailable rather than as success, because this action cannot claim a write it
    // did not make — the sequential double-delete above is the case that must answer success.
    if (!removed) return { ok: false as const, formError: PAYMENT_UNAVAILABLE };

    await recordActivity(tx, {
      groupId: group.id,
      actorId: user.id,
      kind: 'payment.deleted',
      subjectType: 'payment',
      subjectId: existing.id,
      detail: paymentDetail(existing),
    });

    return { ok: true as const };
  });

  if (!outcome.ok) {
    return { ok: false, fieldErrors: outcome.fieldErrors, formError: outcome.formError };
  }

  revalidatePath('/', 'layout');
  return { ok: true, groupId: groupId.data };
}
