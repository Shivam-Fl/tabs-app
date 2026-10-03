'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import { createExpense, updateExpense } from '@/app/actions/expenses';
import type { ExpenseResult } from '@/app/actions/expenses';
import type { ExpenseCategory, ExpenseSplitType } from '@/db/schema';
import {
  currencySymbol,
  formatMinor,
  parseDecimal,
  parseMajorUnits,
  parsePercent,
  split,
  splitRefusalMessage,
} from '@/lib/money';
import type { SplitInput } from '@/lib/money';
import { Button, Field } from '@/components/ui';

/**
 * The one-pass expense form: what it cost, who paid, and how it splits — recording nothing until
 * Save, and resolving the split as it is edited with the SAME split() the server calls before it
 * writes, so the summary a person reads and the rows that get stored cannot disagree.
 *
 * One component serves both writes. Given `initial` it is the edit screen: every field arrives
 * seeded from the stored rule and Save submits updateExpense instead of createExpense. The
 * seeding is what docs/ui.md's Expense form · empty asks for on an edit — there is no empty
 * state there, not even for a split with a remainder, which opens as it was entered.
 *
 * A Client Component for the reasons conventions.md gives: the split-type control swaps the
 * inputs shown without navigating, the summary and payer lines update as they are edited, and the
 * busy state on Save is only observable through useActionState. It imports money.ts and the
 * action — never src/db and never src/lib/auth. The two option lists below are declared here
 * rather than imported from the schema, because importing them would pull drizzle into the
 * browser bundle; they are typed against the schema's own unions, so a value the server would
 * refuse is a compile error rather than a form that submits and comes back rejected.
 */
export interface ExpenseFormMember {
  memberId: string;
  displayName: string;
}

export interface ExpenseFormGroup {
  id: string;
  name: string;
  currency: string;
}

/**
 * An expense as the edit form reopens it, already rendered back to text.
 *
 * Every number is a STRING in the exact form the matching input accepts, and none of it is
 * re-derived here: the page reads the stored rule and turns it into text with src/lib/money.ts,
 * so the form is a renderer of what was saved rather than a second opinion about it. That is what
 * makes "an untouched save writes the same expense again" true — the text goes back through the
 * same parser it came out of (AC-1, AC-2, AC-6).
 *
 * Passed only on the edit screen. Its presence is also what switches the submit to the update
 * action, so there is no separate mode flag to disagree with it.
 */
export interface ExpenseFormInitial {
  expenseId: string;
  description: string;
  amount: string;
  date: string;
  category: string;
  note: string;
  splitType: ExpenseSplitType;
  /** The members whose boxes are ticked in the picker. */
  participants: string[];
  /** memberId -> the number they were given, for the split types that take one. */
  inputs: Record<string, string>;
  /** The members whose payer boxes are ticked. */
  payers: string[];
  /** memberId -> what that payer paid. */
  payerAmounts: Record<string, string>;
}

const CATEGORIES: { value: ExpenseCategory; label: string }[] = [
  { value: 'food', label: 'Food' },
  { value: 'travel', label: 'Travel' },
  { value: 'rent', label: 'Rent' },
  { value: 'utilities', label: 'Utilities' },
  { value: 'shopping', label: 'Shopping' },
  { value: 'entertainment', label: 'Entertainment' },
  { value: 'other', label: 'Other' },
];

const SPLIT_TYPES: { value: ExpenseSplitType; label: string }[] = [
  { value: 'equal', label: 'Equally' },
  { value: 'exact', label: 'Exact amounts' },
  { value: 'percentage', label: 'Percentages' },
  { value: 'shares', label: 'Shares' },
];

/** What the number beside a member's name means, per split type. Equal has no number at all. */
const INPUT_LABELS: Record<Exclude<ExpenseSplitType, 'equal'>, string> = {
  exact: 'Amount for',
  percentage: 'Percent for',
  shares: 'Shares for',
};

type MemberInput = { ok: true; value: bigint | null } | { ok: false; message: string };

/** One member's typed number, in the unit their split type counts in. Blank reads as zero. */
function memberInput(type: ExpenseSplitType, raw: string, currency: string): MemberInput {
  if (type === 'equal') return { ok: true, value: null };

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

type Line = { tone: 'idle' | 'ok' | 'invalid'; message: string };

export function ExpenseForm({
  group,
  members,
  today,
  initial,
}: {
  group: ExpenseFormGroup;
  members: ExpenseFormMember[];
  /**
   * The server's today, handed in rather than read here: this component also renders on the
   * server, and a date worked out in two places either side of midnight is two different dates.
   */
  today: string;
  /** Present on the edit screen only, and what makes this the update form rather than the create one. */
  initial?: ExpenseFormInitial;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const categoryRef = useRef<HTMLSelectElement>(null);
  // One form, two writes: which action it submits to is decided by whether it was handed an
  // expense to reopen, so there is no mode flag that could disagree with the seeded values.
  const [state, formAction, pending] = useActionState<ExpenseResult | null, FormData>(
    initial ? updateExpense : createExpense,
    null,
  );

  const [description, setDescription] = useState(initial?.description ?? '');
  const [amount, setAmount] = useState(initial?.amount ?? '');
  const [date, setDate] = useState(initial?.date ?? today);
  const [category, setCategory] = useState(initial?.category ?? '');
  const [note, setNote] = useState(initial?.note ?? '');
  const [splitType, setSplitType] = useState<ExpenseSplitType>(initial?.splitType ?? 'equal');
  // Every active member is in the split on a new expense (AC-3); on an edit exactly the members
  // the expense was saved with are, including any who have since left the group.
  const [participants, setParticipants] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(
      members.map((member) => [member.memberId, initial ? initial.participants.includes(member.memberId) : true]),
    ),
  );
  const [inputs, setInputs] = useState<Record<string, string>>(() => ({ ...initial?.inputs }));
  // The first member in canonical order pays the whole thing until a second box is ticked. One
  // person paying is the ordinary case, and making it take two more keystrokes is how a one-pass
  // form stops being one pass. Canonical order is the server's own (owner, then created_at, then
  // id), which is the order this list arrived in — the remainder rule is defined against it.
  const [payers, setPayers] = useState<Record<string, boolean>>(() => {
    if (initial) return Object.fromEntries(initial.payers.map((memberId) => [memberId, true]));
    return members[0] ? { [members[0].memberId]: true } : {};
  });
  // Seeded on edit, so the one-payer fallback below never fires on the initial render: an
  // expense whose single payer put in part of the total would otherwise open showing the whole
  // total beside their name, and an untouched save would then store that instead.
  const [payerAmounts, setPayerAmounts] = useState<Record<string, string>>(() => ({
    ...initial?.payerAmounts,
  }));

  useEffect(() => {
    if (state?.ok && state.groupId) router.push(`/groups/${state.groupId}/expenses`);
  }, [state, router]);

  /**
   * Puts back what React's post-action form reset drops.
   *
   * Once an action has run React resets the form. As it re-renders it restores a controlled text
   * field's value, but NOT a `<select>`'s value and NOT a radio's or checkbox's checkedness — so
   * after a refused submit a person would find their split type deselected, every participant
   * unticked and their category back to "No category", on the one screen whose promise is that
   * nothing they entered is lost.
   *
   * The split type is the one that bites twice: an unticked radio is not submitted at all, so
   * the next Save would come back refused for a missing split type — a mistake the person did
   * not make, reported against a control that looks like they did.
   */
  useEffect(() => {
    const form = formRef.current;
    if (!state || !form) return;

    if (categoryRef.current) categoryRef.current.value = category;
    for (const control of form.querySelectorAll<HTMLInputElement>(
      'input[type="radio"], input[type="checkbox"]',
    )) {
      if (control.name === 'splitType') control.checked = control.value === splitType;
      else if (control.name === 'payer') control.checked = Boolean(payers[control.value]);
      else if (control.name === 'participant') {
        control.checked = Boolean(participants[control.value]);
      }
    }
  }, [state, category, splitType, payers, participants]);

  // docs/ui.md: focus moves to the first invalid field, never a toast. The server decides what
  // is invalid, so the search is by the aria-invalid the controls carry — including the picker's
  // first checkbox and the split's first number, which is where a group-level error lives when
  // no single field owns it.
  useEffect(() => {
    if (!state) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [state]);

  const symbol = currencySymbol(group.currency);
  const included = members.filter((member) => participants[member.memberId]);
  const payerList = members.filter((member) => payers[member.memberId]);
  const solePayer = payerList.length === 1;
  const parsedAmount = parseMajorUnits(amount, group.currency);

  // Where a group-level error puts its aria-invalid, so focus has something to land on.
  const payerError = state?.fieldErrors?.payers;
  const participantError = state?.fieldErrors?.participants;
  const splitError = state?.fieldErrors?.split;
  const firstIncludedId = included[0]?.memberId;

  /** What a payer's amount field holds: their own entry, or the total while they are the only one. */
  const payerAmountValue = (memberId: string) =>
    payerAmounts[memberId] ?? (solePayer ? amount : '');

  /**
   * Ticking a payer box, with one wrinkle. While exactly one box is ticked that payer's amount
   * is the total IMPLICITLY, so the moment a second box is ticked the figure that was on screen
   * would vanish and the payer-sum line would jump to "€0.00 — €10.00 short of the total". It
   * is written down first instead, so what a person could see stays on the screen they saw it
   * on, and the line reports only the gap they actually have to close.
   */
  const togglePayer = (memberId: string, checked: boolean) => {
    const only = payerList[0];
    if (checked && solePayer && only && payerAmounts[only.memberId] === undefined && amount.trim() !== '') {
      setPayerAmounts((previous) => ({ ...previous, [only.memberId]: amount }));
    }
    setPayers((previous) => ({ ...previous, [memberId]: checked }));
  };

  // --- the two live lines ------------------------------------------------------------
  let sharesLine: Line;
  if (included.length === 0) {
    sharesLine = { tone: 'invalid', message: 'Choose at least one member to split this expense between.' };
  } else if (!parsedAmount.ok) {
    sharesLine = { tone: 'idle', message: parsedAmount.message };
  } else {
    const splitInputs: SplitInput[] = [];
    let unreadable: Line | null = null;
    for (const member of included) {
      const typed = memberInput(splitType, inputs[member.memberId] ?? '', group.currency);
      if (!typed.ok) {
        unreadable ??= { tone: 'invalid', message: `${member.displayName}: ${typed.message}` };
        continue;
      }
      splitInputs.push({ memberId: member.memberId, value: typed.value });
    }

    if (unreadable) {
      sharesLine = unreadable;
    } else {
      const resolved = split(parsedAmount.minor, splitType, splitInputs);
      sharesLine = resolved.ok
        ? {
            tone: 'ok',
            message: resolved.shares
              .map(
                (share) =>
                  `${members.find((member) => member.memberId === share.memberId)?.displayName ?? 'A member'} ${formatMinor(share.amountMinor, group.currency)}`,
              )
              .join(' · '),
          }
        : { tone: 'invalid', message: splitRefusalMessage(resolved.refusal, group.currency) };
    }
  }

  let payerLine: Line;
  if (payerList.length === 0) {
    payerLine = { tone: 'invalid', message: 'Choose who paid.' };
  } else {
    let sum = 0n;
    let unreadable = false;
    for (const member of payerList) {
      const parsed = parseMajorUnits(payerAmountValue(member.memberId), group.currency);
      if (!parsed.ok) {
        unreadable = true;
        break;
      }
      sum += parsed.minor;
    }

    if (unreadable) payerLine = { tone: 'invalid', message: 'Enter what each payer paid.' };
    else if (!parsedAmount.ok) payerLine = { tone: 'idle', message: parsedAmount.message };
    else if (sum === parsedAmount.minor) {
      payerLine = {
        tone: 'ok',
        message: `Payers add up to ${formatMinor(sum, group.currency)}.`,
      };
    } else {
      const gap = sum < parsedAmount.minor ? parsedAmount.minor - sum : sum - parsedAmount.minor;
      payerLine = {
        tone: 'invalid',
        message: `Payers add up to ${formatMinor(sum, group.currency)} — ${formatMinor(gap, group.currency)} ${
          sum < parsedAmount.minor ? 'short of' : 'over'
        } the total.`,
      };
    }
  }

  const toneClass = (tone: Line['tone']) =>
    tone === 'invalid' ? 'text-negative' : tone === 'ok' ? 'text-positive' : 'text-text-muted';

  return (
    <form ref={formRef} action={formAction} className="flex max-w-[420px] flex-col gap-space-4" noValidate>
      <input type="hidden" name="groupId" value={group.id} />
      {initial ? <input type="hidden" name="expenseId" value={initial.expenseId} /> : null}

      {/* The currency's symbol, fixed and not editable: the group's currency was decided when the
          group was made, and an amount typed against the wrong symbol is a wrong amount. */}
      <div className="flex items-end gap-space-2">
        <span aria-hidden="true" className="flex min-h-[44px] items-center text-base text-text-muted">
          {symbol}
        </span>
        <div className="flex-1">
          <Field
            name="amount"
            label="Amount"
            inputMode="decimal"
            autoComplete="off"
            required
            value={amount}
            onChange={setAmount}
            error={state?.fieldErrors?.amount}
          />
        </div>
      </div>

      <Field
        name="description"
        label="Description"
        autoComplete="off"
        required
        value={description}
        onChange={setDescription}
        error={state?.fieldErrors?.description}
      />

      <Field
        name="date"
        label="Date"
        type="date"
        required
        value={date}
        onChange={setDate}
        error={state?.fieldErrors?.date}
      />

      {/* There is no Select primitive in src/components/ui, and one seven-option control is not
          the second case that justifies adding one: a labelled native select in the Input
          primitive's own classes, as create-group-form does. The server validates the value
          against the enum in src/db/schema.ts regardless of what this renders. */}
      <div className="flex flex-col gap-space-1">
        <label htmlFor="field-category" className="text-sm text-text">
          Category
        </label>
        <select
          ref={categoryRef}
          id="field-category"
          name="category"
          value={category}
          onChange={(event) => setCategory(event.target.value)}
          aria-invalid={state?.fieldErrors?.category ? true : undefined}
          aria-describedby={state?.fieldErrors?.category ? 'field-category-error' : undefined}
          className={`min-h-[44px] rounded-radius border bg-bg px-space-3 text-base text-text ${
            state?.fieldErrors?.category ? 'border-negative' : 'border-border'
          }`}
        >
          <option value="">No category</option>
          {CATEGORIES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {state?.fieldErrors?.category ? (
          <p id="field-category-error" role="alert" className="text-sm text-negative">
            {state.fieldErrors.category}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-space-1">
        <label htmlFor="field-note" className="text-sm text-text">
          Note
        </label>
        <textarea
          id="field-note"
          name="note"
          rows={2}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          aria-invalid={state?.fieldErrors?.note ? true : undefined}
          aria-describedby={state?.fieldErrors?.note ? 'field-note-error' : undefined}
          className={`rounded-radius border bg-bg p-space-3 text-base text-text ${
            state?.fieldErrors?.note ? 'border-negative' : 'border-border'
          }`}
        />
        {state?.fieldErrors?.note ? (
          <p id="field-note-error" role="alert" className="text-sm text-negative">
            {state.fieldErrors.note}
          </p>
        ) : null}
      </div>

      {/* Who paid. A checkbox per member with its own amount, and the live sum underneath. The
          amount defaults to the whole total while exactly one box is ticked, so the ordinary
          one-payer expense needs no typing in this block at all. */}
      <fieldset
        className="flex flex-col gap-space-2"
        aria-describedby={payerError ? 'payers-error' : 'payers-sum'}
      >
        <legend className="text-sm text-text">Who paid</legend>
        {members.map((member, index) => (
          <div key={member.memberId} className="flex flex-col gap-space-1">
            <label className="flex min-h-[44px] items-center gap-space-2">
              <input
                type="checkbox"
                name="payer"
                value={member.memberId}
                checked={Boolean(payers[member.memberId])}
                // A payer error is about the set, not any one box; it lives on the first box so
                // "focus the first invalid field" has somewhere to land.
                aria-invalid={payerError && index === 0 ? true : undefined}
                aria-describedby={payerError && index === 0 ? 'payers-error' : undefined}
                onChange={(event) => togglePayer(member.memberId, event.target.checked)}
              />
              <span>{member.displayName}</span>
            </label>
            {payers[member.memberId] ? (
              <Field
                name={`payerAmount.${member.memberId}`}
                label={`${member.displayName} paid`}
                inputMode="decimal"
                autoComplete="off"
                value={payerAmountValue(member.memberId)}
                onChange={(value) =>
                  setPayerAmounts((previous) => ({ ...previous, [member.memberId]: value }))
                }
              />
            ) : null}
          </div>
        ))}
        {payerError ? (
          <p id="payers-error" role="alert" className="text-sm text-negative">
            {payerError}
          </p>
        ) : null}
        <p id="payers-sum" className={`text-sm ${toneClass(payerLine.tone)}`}>
          {payerLine.message}
        </p>
      </fieldset>

      {/* How it splits. Changing this swaps the number inputs below without navigating (AC-2). */}
      <fieldset className="flex flex-col gap-space-2">
        <legend className="text-sm text-text">Split</legend>
        <div className="flex flex-wrap gap-space-3">
          {SPLIT_TYPES.map((option) => (
            <label key={option.value} className="flex min-h-[44px] items-center gap-space-2">
              <input
                type="radio"
                name="splitType"
                value={option.value}
                checked={splitType === option.value}
                onChange={() => setSplitType(option.value)}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {/* The picker. Every active member is in the split on a new expense (AC-3), and an
          unchecked member gets no share row and no rule row at all. */}
      <fieldset
        className="flex flex-col gap-space-2"
        aria-describedby={participantError ? 'participants-error' : undefined}
      >
        <legend className="text-sm text-text">Split between</legend>
        {members.map((member, index) => (
          <div key={member.memberId} className="flex flex-col gap-space-1">
            <label className="flex min-h-[44px] items-center gap-space-2">
              <input
                type="checkbox"
                name="participant"
                value={member.memberId}
                checked={Boolean(participants[member.memberId])}
                aria-invalid={participantError && index === 0 ? true : undefined}
                aria-describedby={participantError && index === 0 ? 'participants-error' : undefined}
                onChange={(event) =>
                  setParticipants((previous) => ({ ...previous, [member.memberId]: event.target.checked }))
                }
              />
              <span>{member.displayName}</span>
            </label>
            {participants[member.memberId] && splitType !== 'equal' ? (
              <Field
                name={`input.${member.memberId}`}
                label={`${INPUT_LABELS[splitType]} ${member.displayName}`}
                inputMode="decimal"
                autoComplete="off"
                value={inputs[member.memberId] ?? ''}
                onChange={(value) => setInputs((previous) => ({ ...previous, [member.memberId]: value }))}
                // A refusal about the numbers as a set — exact amounts that do not add up,
                // percentages that do not reach 100 — belongs on the first of them, which is
                // where focus goes; one member's own unreadable number belongs on theirs.
                error={
                  state?.fieldErrors?.[`input.${member.memberId}`] ??
                  (splitError && member.memberId === firstIncludedId
                    ? state?.fieldErrors?.split
                    : undefined)
                }
              />
            ) : null}
          </div>
        ))}
        {participantError ? (
          <p id="participants-error" role="alert" className="text-sm text-negative">
            {participantError}
          </p>
        ) : null}
      </fieldset>

      {/* The live summary: what this resolves to right now, or exactly what is off and by how
          much. Computed with the same split() the server calls before it writes (AC-10). */}
      <p aria-live="polite" className={`text-base ${toneClass(sharesLine.tone)}`}>
        {sharesLine.message}
      </p>

      {state?.formError ? (
        <p role="alert" className="text-sm text-negative">
          {state.formError}
        </p>
      ) : null}

      <Button type="submit" size="lg" disabled={pending} busyLabel="Saving…">
        Save expense
      </Button>
    </form>
  );
}
