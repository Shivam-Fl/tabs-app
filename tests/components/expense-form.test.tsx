// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The expense form's three interactive promises, each of which is invisible in markup and only
 * observable by driving the component: the split-type control swaps the inputs shown without
 * navigating, the summary line states what is off and by how much as the split is edited, and a
 * failed submit focuses the first invalid field with everything else left as it was typed.
 *
 * The action is mocked because it reaches a database; this suite is about what the form does
 * with what the action returns, which is exactly the seam a mock is for. The router is a spy so
 * "without navigating" is assertable rather than assumed.
 */
const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }));

/**
 * What the action will answer with on the next submit, how many times it was called, and a
 * hold: with `holding` set the next call parks until `release` is called, which is how the one
 * test about the in-flight button observes a submit that has not come back yet.
 */
interface ActionMock {
  /** What the mocked action answers with. `unknown` on purpose: this file only compares it. */
  result: unknown;
  calls: number;
  holding: boolean;
  release: (() => void) | null;
  /** Which of the two actions the last submit went to — the whole of "create form vs edit form". */
  last: 'createExpense' | 'updateExpense' | null;
}

const action = vi.hoisted(
  (): ActionMock => ({ result: null, calls: 0, holding: false, release: null, last: null }),
);
vi.mock('@/app/actions/expenses', () => {
  const respond = async (name: 'createExpense' | 'updateExpense') => {
    action.calls += 1;
    action.last = name;
    if (action.holding) {
      await new Promise<void>((resolve) => {
        action.release = resolve;
      });
    }
    return action.result;
  };
  return {
    createExpense: () => respond('createExpense'),
    updateExpense: () => respond('updateExpense'),
  };
});

import { ExpenseForm } from '@/components/expense-form';
import type { ExpenseFormInitial } from '@/components/expense-form';

afterEach(cleanup);

beforeEach(() => {
  push.mockClear();
  action.result = null;
  action.calls = 0;
  action.holding = false;
  action.release = null;
  action.last = null;
});

const group = { id: '6b1f2f9c-0f1a-4a4f-9d1f-2f0a6c7b8d90', name: 'Lisbon', currency: 'EUR' };

/** The canonical order readMembers returns: the owner first, then by created_at. */
const members = [
  { memberId: 'm-owner', displayName: 'Priya' },
  { memberId: 'm-sam', displayName: 'Sam' },
  { memberId: 'm-dev', displayName: 'Dev' },
];

function renderForm() {
  return render(<ExpenseForm group={group} members={members} today="2026-10-02" />);
}

/** The two fieldsets that both carry a checkbox per member, found by their legends. */
const payers = () => within(screen.getByRole('group', { name: 'Who paid' }));
const picker = () => within(screen.getByRole('group', { name: 'Split between' }));

function typeAmount(value: string) {
  fireEvent.change(screen.getByLabelText('Amount'), { target: { value } });
}

/** Submits the way a person does, by pressing the button that submits the form. */
function submit() {
  fireEvent.click(screen.getByRole('button', { name: /Save expense/ }));
}

describe('the split-type control', () => {
  it('swaps the inputs shown without navigating', () => {
    renderForm();

    // Equal splits take no numbers at all: the picker is a list of checkboxes and nothing else.
    expect(screen.queryByLabelText('Amount for Priya')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Percent for Priya')).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Exact amounts'));
    expect(screen.getByLabelText('Amount for Priya')).toBeInTheDocument();
    expect(screen.getByLabelText('Amount for Sam')).toBeInTheDocument();

    // Swapping replaces rather than adds: the previous type's inputs are gone, not hidden.
    fireEvent.click(screen.getByLabelText('Percentages'));
    expect(screen.queryByLabelText('Amount for Priya')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Percent for Priya')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Shares'));
    expect(screen.getByLabelText('Shares for Priya')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Equally'));
    expect(screen.queryByLabelText('Shares for Priya')).not.toBeInTheDocument();

    // The whole point: four changes of mind, and not one navigation.
    expect(push).not.toHaveBeenCalled();
  });
});

describe('the live summary', () => {
  it('resolves an equal split between everyone checked', () => {
    renderForm();
    typeAmount('9');

    // 900 minor units between three people is 300 each — no remainder, so no member is named
    // as the one who took the odd unit.
    expect(screen.getByText('Priya €3.00 · Sam €3.00 · Dev €3.00')).toBeInTheDocument();
  });

  it('gives the indivisible unit to the first member in canonical order', () => {
    renderForm();
    typeAmount('10');

    // 1000 between three leaves 1, and TR-3 hands the whole remainder to the first participant
    // — the owner — rather than rounding anyone down.
    expect(screen.getByText('Priya €3.34 · Sam €3.33 · Dev €3.33')).toBeInTheDocument();
  });

  it('states exactly what is off and by how much, in the group’s currency', () => {
    renderForm();
    typeAmount('10');
    fireEvent.click(screen.getByLabelText('Exact amounts'));
    fireEvent.change(screen.getByLabelText('Amount for Priya'), { target: { value: '4' } });

    // 400 typed against a 1000 total: the shortfall is named, not just the fact of it.
    expect(
      screen.getByText('Exact amounts add up to €4.00 — €6.00 short of the total.'),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Amount for Sam'), { target: { value: '9' } });
    expect(
      screen.getByText('Exact amounts add up to €13.00 — €3.00 over the total.'),
    ).toBeInTheDocument();

    // And it resolves the moment they add up, without a round trip.
    fireEvent.change(screen.getByLabelText('Amount for Sam'), { target: { value: '6' } });
    expect(screen.getByText('Priya €4.00 · Sam €6.00 · Dev €0.00')).toBeInTheDocument();
  });

  it('narrows the split to the members left checked', () => {
    renderForm();
    typeAmount('10');
    fireEvent.click(picker().getByLabelText('Sam'));
    fireEvent.click(picker().getByLabelText('Dev'));

    // Only the members still in the split, and only in the order the group reads.
    expect(screen.getByText('Priya €10.00')).toBeInTheDocument();
  });

  it('refuses an empty picker in words rather than dividing by nobody', () => {
    renderForm();
    typeAmount('10');
    for (const member of members) fireEvent.click(picker().getByLabelText(member.displayName));

    expect(
      screen.getByText('Choose at least one member to split this expense between.'),
    ).toBeInTheDocument();
  });
});

describe('the payer-sum line', () => {
  it('starts with the first member in canonical order paying the whole thing', () => {
    renderForm();

    expect(payers().getByLabelText('Priya')).toBeChecked();
    expect(payers().getByLabelText('Sam')).not.toBeChecked();

    // One payer needs no typing: their field mirrors the total, and the line says so.
    typeAmount('10');
    expect(payers().getByLabelText('Priya paid')).toHaveValue('10');
    expect(screen.getByText('Payers add up to €10.00.')).toBeInTheDocument();
  });

  it('names the discrepancy in minor units as payer amounts are edited', () => {
    renderForm();
    typeAmount('10');
    fireEvent.click(payers().getByLabelText('Sam'));

    // Ticking a second payer keeps the figure that was on screen rather than clearing it, so
    // the line starts from the total and reports the gap the person has to close.
    expect(payers().getByLabelText('Priya paid')).toHaveValue('10');

    fireEvent.change(payers().getByLabelText('Sam paid'), { target: { value: '4' } });
    expect(screen.getByText('Payers add up to €14.00 — €4.00 over the total.')).toBeInTheDocument();

    fireEvent.change(payers().getByLabelText('Priya paid'), { target: { value: '6' } });
    expect(screen.getByText('Payers add up to €10.00.')).toBeInTheDocument();
  });

  it('refuses a set of payers nobody is in', () => {
    renderForm();
    typeAmount('10');
    fireEvent.click(payers().getByLabelText('Priya'));

    expect(screen.getByText('Choose who paid.')).toBeInTheDocument();
  });
});

describe('a failed submit', () => {
  it('focuses the first invalid field and keeps every value that was typed', async () => {
    renderForm();

    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Dinner' } });
    typeAmount('-5');
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'the one by the river' } });
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'food' } });
    fireEvent.click(screen.getByLabelText('Exact amounts'));
    fireEvent.change(screen.getByLabelText('Amount for Priya'), { target: { value: '5' } });
    fireEvent.change(payers().getByLabelText('Priya paid'), { target: { value: '5' } });

    action.result = {
      ok: false,
      fieldErrors: {
        amount: 'Enter a positive amount, without a sign.',
        description: 'Keep the description under 200 characters.',
      },
    };

    submit();

    // The error lands beside the field it belongs to — and not only there: focus goes to it.
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText('Amount'));
    });
    // Beside the field, wired to it by aria-describedby — three elements on this screen say
    // this sentence, because the same parser the server uses computed the same refusal live.
    // Reached through the input's OWN aria-describedby rather than through a literal id: Field
    // mints a per-instance id now, and a test that hardcoded `field-amount-error` was asserting
    // the old naming scheme rather than that the message is attached to the field it belongs to.
    const amount = screen.getByLabelText('Amount');
    const describedBy = amount.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy as string)).toHaveTextContent(
      'Enter a positive amount, without a sign.',
    );
    expect(amount).toHaveAttribute('aria-invalid', 'true');

    // Everything else is exactly as it was typed. React resets an uncontrolled form when its
    // action runs, and losing a half-filled expense to one bad field is the failure this
    // prevents.
    // Let React finish the commit the action's result started, so what is asserted below is
    // the settled screen rather than one mid-update.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByLabelText('Description')).toHaveValue('Dinner');
    expect(screen.getByLabelText('Note')).toHaveValue('the one by the river');
    expect(screen.getByLabelText('Category')).toHaveValue('food');
    expect(screen.getByLabelText('Exact amounts')).toBeChecked();
    expect(screen.getByLabelText('Amount for Priya')).toHaveValue('5');
    expect(payers().getByLabelText('Priya paid')).toHaveValue('5');

    // A failed submit stays on the form rather than navigating away from it.
    expect(push).not.toHaveBeenCalled();
  });

  it('puts a form-level failure above the action and keeps the values too', async () => {
    renderForm();

    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Dinner' } });
    typeAmount('10');
    action.result = { ok: false, formError: 'That group is not available.' };

    submit();

    await waitFor(() => {
      expect(screen.getByText('That group is not available.')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Description')).toHaveValue('Dinner');
  });

  it('disables Save while the action is in flight, so one press is one expense (AC-18)', async () => {
    renderForm();
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Dinner' } });
    typeAmount('10');

    action.holding = true;
    submit();

    // The button says what it is doing and cannot be pressed again: a double tap on a slow
    // connection is one expense and one feed entry, not two.
    const save = screen.getByRole('button', { name: /Save expense|Saving/ });
    await waitFor(() => {
      expect(save).toBeDisabled();
    });
    expect(save).toHaveTextContent('Saving…');

    fireEvent.click(save);
    expect(action.calls).toBe(1);

    // And the press it did take still lands: releasing the hold navigates as it always would.
    // Left un-released, the transition would still be pending when the next test renders.
    action.result = { ok: true, groupId: group.id };
    action.holding = false;
    action.release?.();
    await waitFor(() => {
      expect(push).toHaveBeenCalledWith(`/groups/${group.id}/expenses`);
    });
  });

  it('navigates to the group’s list only when the action accepted the expense', async () => {
    renderForm();

    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Dinner' } });
    typeAmount('10');
    action.result = { ok: true, groupId: group.id };

    submit();

    await waitFor(() => {
      expect(push).toHaveBeenCalledWith(`/groups/${group.id}/expenses`);
    });
  });
});

describe('the picker’s defaults', () => {
  it('starts with every active member in the split', () => {
    renderForm();

    for (const member of members) {
      expect(picker().getByLabelText(member.displayName)).toBeChecked();
    }
  });
});

/**
 * The same component on its other route. The edit screen hands it the stored expense rendered back
 * to text and it must open showing exactly that — including a split with a remainder, which is
 * shown as entered rather than re-normalised — and then write with updateExpense.
 */
function renderEditForm(initial: ExpenseFormInitial) {
  return render(<ExpenseForm group={group} members={members} today="2026-10-02" initial={initial} />);
}

const stored: ExpenseFormInitial = {
  expenseId: 'e-1',
  description: 'Taxi to the airport',
  amount: '31.5',
  date: '2026-09-28',
  category: 'travel',
  note: 'bolt',
  splitType: 'exact',
  participants: ['m-owner', 'm-sam'],
  inputs: { 'm-owner': '10', 'm-sam': '21.5' },
  payers: ['m-owner'],
  payerAmounts: { 'm-owner': '31.5' },
};

describe('the edit form', () => {
  it('opens every field from the stored rule rather than from the new-expense defaults', () => {
    renderEditForm(stored);

    expect(screen.getByLabelText('Description')).toHaveValue('Taxi to the airport');
    expect(screen.getByLabelText('Amount')).toHaveValue('31.5');
    expect(screen.getByLabelText('Date')).toHaveValue('2026-09-28');
    expect(screen.getByLabelText('Category')).toHaveValue('travel');
    expect(screen.getByLabelText('Note')).toHaveValue('bolt');
    expect(screen.getByLabelText('Exact amounts')).toBeChecked();

    // The picker shows exactly the members the expense was saved with, checked, and the numbers
    // they were given — not a re-normalised version of the rule.
    expect(picker().getByLabelText('Priya')).toBeChecked();
    expect(picker().getByLabelText('Sam')).toBeChecked();
    expect(picker().getByLabelText('Dev')).not.toBeChecked();
    expect(screen.getByLabelText('Amount for Priya')).toHaveValue('10');
    expect(screen.getByLabelText('Amount for Sam')).toHaveValue('21.5');

    // And the payers, with what each of them put in.
    expect(payers().getByLabelText('Priya')).toBeChecked();
    expect(payers().getByLabelText('Sam')).not.toBeChecked();
    expect(payers().getByLabelText('Priya paid')).toHaveValue('31.5');

    // The live summary resolves the stored rule, so an untouched save is visibly a no-op.
    expect(screen.getByText('Priya €10.00 · Sam €21.50')).toBeInTheDocument();
  });

  it('keeps a single payer’s stored amount instead of the implicit total', () => {
    // The one-payer fallback exists so a NEW expense needs no typing in the payer block. On a
    // reopened one it must not overwrite what was stored: this payer put in part of the total,
    // and an untouched save has to store that part again rather than the whole total.
    renderEditForm({ ...stored, payers: ['m-owner'], payerAmounts: { 'm-owner': '10' } });

    expect(payers().getByLabelText('Priya paid')).toHaveValue('10');
    expect(screen.getByText('Payers add up to €10.00 — €21.50 short of the total.')).toBeInTheDocument();
  });

  it('submits the update action, carrying the expense it was opened with', async () => {
    renderEditForm(stored);
    expect(document.querySelector<HTMLInputElement>('input[name="expenseId"]')).toHaveValue('e-1');

    action.result = { ok: true, groupId: group.id };
    submit();

    await waitFor(() => {
      expect(action.last).toBe('updateExpense');
    });
    // The list is where an edit lands, the same as a create: the row a person just changed is
    // there to be read.
    await waitFor(() => {
      expect(push).toHaveBeenCalledWith(`/groups/${group.id}/expenses`);
    });
  });

  it('still writes with the create action when no expense was handed to it', async () => {
    renderForm();
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Dinner' } });
    typeAmount('10');

    action.result = { ok: true, groupId: group.id };
    submit();

    await waitFor(() => {
      expect(action.last).toBe('createExpense');
    });
    expect(document.querySelector('input[name="expenseId"]')).toBeNull();
  });
});
