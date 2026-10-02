// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { BalancesScreen } from '@/components/balances-screen';
import type { GroupRow } from '@/lib/access';
import type { NamedBalance, Transfer } from '@/lib/balances';

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

describe('the balances screen', () => {
  it('has exactly one h1, a back link to the group, and the group’s name beneath', () => {
    const { container } = render(
      <BalancesScreen group={group} members={members} transfers={transfers} />,
    );

    const headings = [...container.querySelectorAll('h1')];
    expect(headings).toHaveLength(1);
    expect(headings[0]?.textContent).toBe('Balances');
    expect(screen.getByRole('link', { name: '← Lisbon' })).toHaveAttribute(
      'href',
      `/groups/${group.id}`,
    );
  });

  it('states every member’s balance as a direction in words beside the figure', () => {
    render(<BalancesScreen group={group} members={members} transfers={transfers} />);

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
    expect(screen.getByText('Priya').closest('li')).toHaveTextContent('is owed');
    expect(screen.getByText('Sam').closest('li')).toHaveTextContent('owes');
    expect(screen.getByText('Ana').closest('li')).toHaveTextContent('settled');
  });

  it('renders the transfers as "A pays B ₹X", in the block the design calls the answer', () => {
    render(<BalancesScreen group={group} members={members} transfers={transfers} />);

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

  it('says the group is square, in the design document’s own words, when there is nothing to settle', () => {
    // Guards the extraction itself: if docs/ui.md is reworded, this fails here rather than
    // silently comparing two empty strings.
    expect(SETTLED).toBe("Everyone's square in this group.");

    render(<BalancesScreen group={group} members={members} transfers={[]} />);

    const rendered = screen.getByText(/square in this group/).textContent ?? '';
    expect(rendered).toBe(SETTLED);
    // ASCII apostrophe U+0027, not the U+2019 an editor produces.
    expect(rendered.codePointAt(8)).toBe(0x0027);
    expect('Everyone’s square in this group.'.codePointAt(8)).toBe(0x2019);
  });

  it('offers Record payment as a disabled control with the reason it cannot be used yet', () => {
    // TR-7's write path is piece 7. The control is present and disabled rather than absent, so
    // the screen still answers "how do I record one" instead of leaving it to be guessed at.
    render(<BalancesScreen group={group} members={members} transfers={transfers} />);

    expect(screen.getByRole('button', { name: 'Record payment' })).toBeDisabled();
    expect(screen.getByText(/not built yet/i)).toBeInTheDocument();
  });
});
