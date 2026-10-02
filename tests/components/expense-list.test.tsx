// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ExpenseList } from '@/components/expense-list';
import type { ExpenseRow, GroupRow } from '@/lib/access';

afterEach(cleanup);

/**
 * Both of this screen's designed strings, read out of docs/ui.md rather than retyped here: a
 * reworded design document must fail a test in this repository rather than pass the suite and
 * fail the criterion in QA.
 */
const UI_MD = readFileSync(join(process.cwd(), 'docs', 'ui.md'), 'utf8');
/** docs/ui.md, Patterns · Empty state: the no-expenses-yet example. */
const EMPTY_EXAMPLE = /No expenses yet — "([^"]+)"/.exec(UI_MD)?.[1] ?? '';

const group: GroupRow = {
  id: '6b1f2f9c-0f1a-4a4f-9d1f-2f0a6c7b8d90',
  name: 'Lisbon',
  currency: 'EUR',
  type: 'trip',
  archivedAt: null,
};

const dinner: ExpenseRow = {
  id: 'e-1',
  description: 'Dinner',
  amountMinor: 4200n,
  currency: 'EUR',
  splitType: 'equal',
  category: 'food',
  note: null,
  date: '2026-09-30',
  createdAt: new Date('2026-09-30T20:00:00.000Z'),
  payers: [
    { memberId: 'm-owner', displayName: 'Priya', amountMinor: 4200n },
  ],
};

const taxi: ExpenseRow = {
  id: 'e-2',
  description: 'Taxi to the airport',
  amountMinor: 3150n,
  currency: 'EUR',
  splitType: 'shares',
  category: null,
  note: 'bolt',
  date: '2026-10-01',
  createdAt: new Date('2026-10-01T09:00:00.000Z'),
  payers: [
    { memberId: 'm-owner', displayName: 'Priya', amountMinor: 1050n },
    { memberId: 'm-sam', displayName: 'Sam', amountMinor: 2100n },
  ],
};

describe('the expenses list', () => {
  it('reads the design document’s empty-state sentence, so a retyped one is not what is asserted', () => {
    expect(EMPTY_EXAMPLE).toBe('Add the first expense for this group.');
  });

  it('shows the no-expenses-yet state with the one action that creates the first one', () => {
    render(<ExpenseList group={group} expenses={[]} />);

    expect(screen.getByRole('heading', { name: 'No expenses yet' })).toBeInTheDocument();
    expect(screen.getByText(EMPTY_EXAMPLE)).toBeInTheDocument();

    // One Add expense link and one only: the empty state IS the action, so the bottom nav that
    // a populated list carries is not rendered beside it.
    const links = screen.getAllByRole('link', { name: 'Add expense' });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', `/groups/${group.id}/expenses/new`);
    // And no list at all, rather than an empty one.
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('renders a row per expense with the description, the payers and the date', () => {
    render(<ExpenseList group={group} expenses={[taxi, dinner]} />);

    expect(screen.getByText('Taxi to the airport')).toBeInTheDocument();
    expect(screen.getByText('Dinner')).toBeInTheDocument();

    expect(screen.getByText('Paid by Priya')).toBeInTheDocument();
    // Several payers are listed with their parts, because "Priya and Sam" would leave the split
    // of the total unstated on the one row where it matters.
    expect(screen.getByText('Paid by Priya €10.50, Sam €21.00')).toBeInTheDocument();

    expect(screen.getByText('2026-10-01')).toBeInTheDocument();
    expect(screen.getByText('2026-09-30')).toBeInTheDocument();

    // The action row is present again once there is something to add to.
    expect(screen.getAllByRole('link', { name: 'Add expense' })).toHaveLength(1);
  });

  it('renders the rows in the order it was given, newest first, without sorting them again', () => {
    // Reversed input, reversed output: the ordering is readExpensesForGroup's, and a second sort
    // here would be a second answer to the same question — one that could disagree with the one
    // the index was chosen for.
    render(<ExpenseList group={group} expenses={[dinner, taxi]} />);

    const rows = screen.getAllByRole('listitem').map((row) => row.textContent ?? '');
    expect(rows[0]).toContain('Dinner');
    expect(rows[1]).toContain('Taxi to the airport');
  });

  it('shows a category chip only when a category is set', () => {
    render(<ExpenseList group={group} expenses={[taxi, dinner]} />);

    const dinnerRow = screen.getByText('Dinner').closest('li');
    const taxiRow = screen.getByText('Taxi to the airport').closest('li');
    expect(dinnerRow).not.toBeNull();
    expect(taxiRow).not.toBeNull();

    expect(within(dinnerRow as HTMLElement).getByText('food')).toBeInTheDocument();
    // A null category renders no chip at all, not an empty one.
    expect(within(taxiRow as HTMLElement).queryByText(/food|travel|rent/)).not.toBeInTheDocument();
  });

  it('renders the amount as a plain mono figure, never the direction-worded Money primitive', () => {
    render(<ExpenseList group={group} expenses={[dinner]} />);

    const amount = screen.getByText('€42.00');
    // Tabular figures so a column of money aligns on the decimal point (AC-12).
    expect(amount).toHaveClass('font-mono');
    expect(amount).toHaveClass('tabular-nums');

    /**
     * And nothing else. Money's whole contract is the direction words beside the figure and the
     * colour that repeats them; an expense's amount has no direction — it is neither owed nor
     * owing, it is what was spent — so the primitive must not be what rendered this.
     */
    expect(amount.className).toBe('font-mono tabular-nums');
    expect(amount.querySelector('.sr-only')).toBeNull();
    expect(screen.queryByText(/you are owed|you owe|settled/)).not.toBeInTheDocument();

    // Right-aligned against the row's edge, and never wrapping onto its own line.
    expect(amount.closest('li')?.lastElementChild).toHaveClass('items-end');
  });
});
