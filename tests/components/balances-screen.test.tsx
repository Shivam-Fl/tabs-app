// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BalancesScreen } from '@/components/balances-screen';
import type { GroupRow, PaymentRow } from '@/lib/access';
import type { NamedBalance, Transfer } from '@/lib/balances';

// The screen renders the Record payment form and a delete control per payment, both of which
// import Server Actions, which import the database. This suite asserts markup, so they are
// stand-ins; the one case that needs a pending action installs its own unresolved promise.
const paymentActions = vi.hoisted(() => ({
  recordPayment: vi.fn(),
  deletePayment: vi.fn(),
}));
vi.mock('@/app/actions/payments', () => paymentActions);
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

afterEach(cleanup);

/**
 * The settled sentence read out of docs/ui.md rather than retyped here, for the reason the
 * overview's empty-state suite gives: a sentence typed from memory passes this suite and fails
 * the criterion in QA. An em dash that became a hyphen and an apostrophe an editor curled both
 * fail here instead.
 */
const UI_MD = readFileSync(join(process.cwd(), 'docs', 'ui.md'), 'utf8').split('\n');

/** docs/ui.md line 165: the settled message that replaces the transfer list. */
const SETTLED = /the settled message — "(.+)"/.exec(UI_MD[164] ?? '')?.[1] ?? '';

const group: GroupRow = {
  id: '6b1f2f9c-0f1a-4a4f-9d1f-2f0a6c7b8d90',
  name: 'Lisbon',
  currency: 'EUR',
  type: 'trip',
  archivedAt: null,
};

const members: NamedBalance[] = [
  { memberId: 'm-priya', displayName: 'Priya', balanceMinor: 1250n },
  { memberId: 'm-sam', displayName: 'Sam', balanceMinor: -1250n },
  { memberId: 'm-ana', displayName: 'Ana', balanceMinor: 0n },
];

const transfers: Transfer[] = [
  { fromMemberId: 'm-sam', toMemberId: 'm-priya', amountMinor: 1250n },
];

/** Newest first, as the read returns them: one Priya is part of, one she is not. */
const payments: PaymentRow[] = [
  {
    id: 'p-2',
    fromMemberId: 'm-sam',
    fromName: 'Sam',
    toMemberId: 'm-priya',
    toName: 'Priya',
    amountMinor: 600n,
    note: null,
    createdAt: new Date('2026-01-05T10:00:00.000Z'),
  },
  {
    id: 'p-1',
    fromMemberId: 'm-ana',
    fromName: 'Ana',
    toMemberId: 'm-sam',
    toName: 'Sam',
    amountMinor: 200n,
    note: 'kiosk',
    createdAt: new Date('2026-01-03T10:00:00.000Z'),
  },
];

/** The viewer is Priya: involved in the first payment, a third party to the second. */
function renderScreen(overrides: Partial<Parameters<typeof BalancesScreen>[0]> = {}) {
  return render(
    <BalancesScreen
      group={group}
      members={members}
      transfers={transfers}
      payments={payments}
      viewerMemberId="m-priya"
      {...overrides}
    />,
  );
}

describe('the balances screen', () => {
  it('has exactly one h1, a back link to the group, and the group’s name beneath', () => {
    const { container } = renderScreen();

    const headings = [...container.querySelectorAll('h1')];
    expect(headings).toHaveLength(1);
    expect(headings[0]?.textContent).toBe('Balances');
    expect(screen.getByRole('link', { name: '← Lisbon' })).toHaveAttribute(
      'href',
      `/groups/${group.id}`,
    );
  });

  it('states every member’s balance as a direction in words beside the figure', () => {
    renderScreen();

    // The words are visible, not clipped to a screen reader: colour alone is the one signal the
    // design document forbids, and it was the only one a sighted reader had before this piece.
    expect(screen.getByText('is owed')).toBeVisible();
    expect(screen.getByText('owes')).toBeVisible();
    expect(screen.getByText('settled')).toBeVisible();

    // And the figure is the group's currency, in the symbol form (TR-23): Priya's row and the
    // transfer that settles it both read €12.50.
    expect(screen.getAllByText('€12.50')).toHaveLength(2);
    expect(screen.getByText('-€12.50')).toBeInTheDocument();

    // A row per member, so the table is a list and the amount stays right-aligned in it.
    // Scoped to the table, because the same three names are options in the form's two selects.
    const table = screen.getByRole('heading', { name: 'Net balances' }).closest('section') as HTMLElement;
    expect(within(table).getByText('Priya').closest('li')).toHaveTextContent('is owed');
    expect(within(table).getByText('Sam').closest('li')).toHaveTextContent('owes');
    expect(within(table).getByText('Ana').closest('li')).toHaveTextContent('settled');
  });

  it('renders the transfers as "A pays B ₹X", in the block the design calls the answer', () => {
    renderScreen();

    const line = screen.getByText('Sam pays Priya').closest('li');
    expect(line).toHaveTextContent('€12.50');
    // docs/ui.md, Balances · ideal: the transfer list is the visually dominant block. It is the
    // larger type of the two lists on the screen, and this is what keeps it so.
    expect(line).toHaveClass('text-lg');
    expect(screen.getByRole('heading', { name: 'Settle up' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Net balances' })).toBeInTheDocument();

    // The settled sentence is not a thing to say when there is something to do.
    expect(screen.queryByText(/square in this group/)).not.toBeInTheDocument();
  });

  it('settled message still renders when transfers empty and payments empty', () => {
    // Guards the extraction itself: if docs/ui.md is reworded, this fails here rather than
    // silently comparing two empty strings.
    expect(SETTLED).toBe("Everyone's square in this group.");

    renderScreen({ transfers: [], payments: [] });

    const rendered = screen.getByText(/square in this group/).textContent ?? '';
    expect(rendered).toBe(SETTLED);
    // ASCII apostrophe U+0027, not the U+2019 an editor produces.
    expect(rendered.codePointAt(8)).toBe(0x0027);
    expect('Everyone’s square in this group.'.codePointAt(8)).toBe(0x2019);

    // A group nobody has settled anything in says only that: an empty Payments heading under it
    // would be a region saying nothing (TR-9).
    expect(screen.queryByRole('heading', { name: 'Payments' })).not.toBeInTheDocument();
  });

  it('Record payment form renders with from/to/amount/note and submit busy Recording state', async () => {
    // Never resolves, so the action stays pending for the whole assertion below.
    paymentActions.recordPayment.mockReturnValue(new Promise(() => {}));

    renderScreen();

    expect(screen.getByRole('heading', { name: 'Record payment' })).toBeInTheDocument();
    // A label on every control, and the two member selects offer exactly the group's members.
    const from = screen.getByLabelText('From');
    const to = screen.getByLabelText('To');
    expect(screen.getByLabelText('Amount')).toBeInTheDocument();
    expect(screen.getByLabelText('Note')).toBeInTheDocument();
    expect(within(from).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Choose who paid',
      'Priya',
      'Sam',
      'Ana',
    ]);
    expect(within(to).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Choose who was paid',
      'Priya',
      'Sam',
      'Ana',
    ]);

    const submit = screen.getByRole('button', { name: 'Record payment' });
    expect(submit).toBeEnabled();

    fireEvent.submit(submit.closest('form') as HTMLFormElement);

    // docs/ui.md: the submit is the busy state — it disables and says what it is doing, and
    // nothing else on the screen claims to be working (AC-10).
    await waitFor(() => expect(screen.getByRole('button', { name: 'Recording…' })).toBeDisabled());
    expect(screen.queryAllByRole('progressbar')).toHaveLength(0);
    // The per-row delete controls are untouched by the form's pending state.
    expect(screen.getByRole('button', { name: 'Delete €6.00 from Sam to Priya' })).toBeEnabled();
  });

  it('payments list renders newest first with per-row delete button naming the payment', () => {
    renderScreen();

    expect(screen.getByRole('heading', { name: 'Payments' })).toBeInTheDocument();
    const rows = screen.getAllByRole('listitem').filter((row) => /from .+ to /.test(row.textContent ?? ''));
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('€6.00 from Sam to Priya'),
      expect.stringContaining('€2.00 from Ana to Sam'),
    ]);

    // The date and the note the person typed, on the row they belong to.
    expect(rows[0]).toHaveTextContent('2026-01-05');
    expect(rows[1]).toHaveTextContent('kiosk');

    // The control names the payment, because a screen of buttons all reading "Delete payment"
    // tells a reader nothing about which one they are on.
    const deletes = screen.getAllByRole('button', { name: /^Delete / });
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toHaveAccessibleName('Delete €6.00 from Sam to Priya');

    // Only the two members the payment involves get the control: Priya is the payee on the first
    // and a stranger to the second (TR-7).
    expect(rows[0]).toContainElement(deletes[0]);
    expect(rows[1]).not.toContainElement(deletes[0]);
  });

  it('withholds the delete control from a viewer who is not one of the two members', () => {
    renderScreen({ viewerMemberId: 'm-ana' });

    // Ana is the payer on the older payment and no part of the newer one, so exactly one control
    // is rendered and it is on her row.
    const deletes = screen.getAllByRole('button', { name: /^Delete / });
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toHaveAccessibleName('Delete €2.00 from Ana to Sam');
  });
});
