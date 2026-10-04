// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { archiveGroup } from '@/app/actions/groups';
import { GroupList } from '@/components/group-list';
import { GroupOverview } from '@/components/group-overview';
import { MembersScreen } from '@/components/members-screen';
import type { ActivityRow, GroupRow, GroupSummary, InviteRow, MemberRow, Membership } from '@/lib/access';
import { SETTLE_FIRST_MESSAGE, type HomeSummaryTotals, type Transfer } from '@/lib/balances';

// MembersScreen renders the leave and remove controls, and the owner section renders the rename
// form and the archive control — all of which import Server Actions, which import the database.
// This suite asserts markup, so they are replaced with stand-ins that are never invoked.
vi.mock('@/app/actions/members', () => ({
  leaveGroup: vi.fn(),
  undoLeave: vi.fn(),
  removeMember: vi.fn(),
  joinWithToken: vi.fn(),
  addPlaceholderMember: vi.fn(),
  claimPlaceholder: vi.fn(),
  rotateInviteLink: vi.fn(),
  setInviteEnabled: vi.fn(),
}));
vi.mock('@/app/actions/groups', () => ({
  createGroup: vi.fn(),
  renameGroup: vi.fn(),
  archiveGroup: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

afterEach(cleanup);

const group: GroupRow = {
  id: '6b1f2f9c-0f1a-4a4f-9d1f-2f0a6c7b8d90',
  name: 'Lisbon',
  currency: 'EUR',
  type: 'trip',
  archivedAt: null,
};

const owner: MemberRow = {
  memberId: 'm-owner',
  displayName: 'Priya',
  isOwner: true,
  isPlaceholder: false,
  balanceMinor: 0n,
};
const other: MemberRow = {
  memberId: 'm-other',
  displayName: 'Sam',
  isOwner: false,
  isPlaceholder: false,
  balanceMinor: 0n,
};

const invite: InviteRow = { token: 'tok-abc123', enabled: true };

const ownerView: Membership = { memberId: owner.memberId, groupId: group.id, userId: 'u-owner', isOwner: true };
const memberView: Membership = { memberId: other.memberId, groupId: group.id, userId: 'u-other', isOwner: false };

const entry: ActivityRow = {
  id: 'a-1',
  kind: 'member.joined',
  actorId: 'u-other',
  actorName: 'Sam',
  memberId: other.memberId,
  createdAt: new Date('2026-01-02T03:04:05.000Z'),
};

const summaries: GroupSummary[] = [{ id: group.id, name: 'Lisbon', type: 'trip', currency: 'EUR', balanceMinor: 0n }];

/** The props the home list needs beyond the groups themselves. */
const noSummary = { summary: null, summaryCurrency: 'EUR', failedGroupIds: [] as string[] };

const transfer: Transfer = { fromMemberId: other.memberId, toMemberId: owner.memberId, amountMinor: 1250n };

function h1s(container: HTMLElement): Element[] {
  return [...container.querySelectorAll('h1')];
}

describe('the group overview', () => {
  it('has exactly one h1 and shows the name, type and currency', () => {
    const { container } = render(
      <GroupOverview group={group} members={[owner]} transfers={[]} entries={[]} />,
    );

    expect(h1s(container)).toHaveLength(1);
    expect(h1s(container)[0]?.textContent).toBe('Lisbon');
    expect(screen.getByText('trip · EUR')).toBeInTheDocument();
  });

  it('renders every member at their real balance, in the group’s currency', () => {
    const owed: MemberRow = { ...owner, balanceMinor: 1250n };
    const owing: MemberRow = { ...other, balanceMinor: -600n };
    render(<GroupOverview group={group} members={[owed, owing]} transfers={[]} entries={[entry]} />);

    // The symbol form, per TR-23: '€12.50' and not 'EUR 12.50'.
    expect(screen.getByText(/€12\.50/)).toBeInTheDocument();
    expect(screen.getByText(/-€6\.00/)).toBeInTheDocument();
  });

  it('states each direction in visible words, not in colour alone', () => {
    const owed: MemberRow = { ...owner, balanceMinor: 1250n };
    const owing: MemberRow = { ...other, balanceMinor: -600n };
    const square: MemberRow = { ...other, memberId: 'm-square', displayName: 'Ana', balanceMinor: 0n };

    const { unmount } = render(
      <GroupOverview group={group} members={[owed, square]} transfers={[]} entries={[]} />,
    );
    // The regression this pins: the primitive rendered the direction sr-only, so a sighted
    // reader had the colour and nothing else — the one signal TR-23 forbids relying on.
    expect(screen.getByText('is owed')).toBeInTheDocument();
    expect(screen.getByText('settled')).toBeInTheDocument();
    // Third person on a row labelled with somebody else's name: a table of every member saying
    // "you" is a table nobody can read.
    expect(screen.queryByText('you are owed')).not.toBeInTheDocument();
    unmount();

    render(<GroupOverview group={group} members={[owing]} transfers={[]} entries={[]} />);
    expect(screen.getByText('owes')).toBeInTheDocument();
  });

  it('lists the transfers it is handed, and says the group is square when there are none', () => {
    const { unmount } = render(
      <GroupOverview group={group} members={[owner, other]} transfers={[]} entries={[]} />,
    );
    expect(screen.getByText(/Everyone.s square in this group\./)).toBeInTheDocument();
    unmount();

    render(<GroupOverview group={group} members={[owner, other]} transfers={[transfer]} entries={[]} />);
    expect(screen.getByText('Sam pays Priya')).toBeInTheDocument();
    expect(screen.getByText(/€12\.50/)).toBeInTheDocument();
    expect(screen.queryByText(/Everyone.s square in this group\./)).not.toBeInTheDocument();
  });

  it('renders the archived notice for an archived group', () => {
    const { unmount } = render(
      <GroupOverview group={group} members={[owner]} transfers={[]} entries={[]} />,
    );
    expect(screen.queryByText('This group is archived.')).not.toBeInTheDocument();
    unmount();

    render(
      <GroupOverview
        group={{ ...group, archivedAt: new Date('2026-02-01T00:00:00.000Z') }}
        members={[owner]}
        transfers={[]}
        entries={[]}
      />,
    );
    expect(screen.getByText('This group is archived.')).toBeInTheDocument();
  });
});

describe('the members screen', () => {
  it('has exactly one h1 and lists every member with their role', () => {
    const { container } = render(<MembersScreen group={group} members={[owner, other]} viewer={ownerView} invite={invite} />);

    expect(h1s(container)).toHaveLength(1);
    expect(h1s(container)[0]?.textContent).toBe('Members');
    expect(screen.getByText('Priya')).toBeInTheDocument();
    expect(screen.getByText('Sam')).toBeInTheDocument();
    expect(screen.getByText('Owner')).toBeInTheDocument();
    expect(screen.getByText('Member')).toBeInTheDocument();
  });

  it('gives the owner the owner-only controls and no Leave, and the plain member none of them', () => {
    const { unmount } = render(<MembersScreen group={group} members={[owner, other]} viewer={ownerView} invite={invite} />);
    expect(screen.getByRole('heading', { name: 'Rename' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Archive' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Archive Lisbon' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Leave' })).not.toBeInTheDocument();
    unmount();

    render(<MembersScreen group={group} members={[owner, other]} viewer={memberView} invite={invite} />);
    expect(screen.queryByRole('heading', { name: 'Rename' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Archive' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
  });

  it('puts Remove on the other member’s row, and Leave only on the viewer’s own', () => {
    const { unmount } = render(<MembersScreen group={group} members={[owner, other]} viewer={ownerView} invite={invite} />);
    // The owner sees Remove against Sam, one row, and never against their own.
    expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(1);
    expect(screen.getByText('Sam').closest('li')).toContainElement(screen.getByRole('button', { name: 'Remove' }));
    unmount();

    render(<MembersScreen group={group} members={[owner, other]} viewer={memberView} invite={invite} />);
    expect(screen.getAllByRole('button', { name: 'Leave' })).toHaveLength(1);
    expect(screen.getByText('Sam').closest('li')).toContainElement(screen.getByRole('button', { name: 'Leave' }));
  });

  it('announces a finished archive instead of claiming to still be working', async () => {
    vi.mocked(archiveGroup).mockResolvedValue({ ok: true, groupId: group.id });
    render(<MembersScreen group={group} members={[owner]} viewer={ownerView} invite={invite} />);

    fireEvent.click(screen.getByRole('button', { name: 'Archive Lisbon' }));

    // Button renders its busyLabel in place of the children for the whole time it is disabled,
    // so a busy label left on after the action resolves hides the resting state and the button
    // reads 'Archiving…' for good — claiming to be working on something it has finished.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Archived' })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Archiving…' })).not.toBeInTheDocument();
  });

  it('tells the owner to archive rather than leave, and offers no way out', () => {
    render(<MembersScreen group={group} members={[owner, other]} viewer={ownerView} invite={invite} />);
    expect(screen.getByText(/archive it/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Leave' })).not.toBeInTheDocument();
  });

  it('confirms a removal in a dialog that names the member, and Escape dismisses it', () => {
    render(<MembersScreen group={group} members={[owner, other]} viewer={ownerView} invite={invite} />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Remove Sam?' })).toBeInTheDocument();
    expect(dialog).toHaveTextContent("Sam will no longer appear in this group's balances.");

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('withholds Leave and Remove from a member whose balance is not zero, and says why', () => {
    const owing: MemberRow = { ...other, balanceMinor: -600n };
    const { unmount } = render(
      <MembersScreen group={group} members={[owner, owing]} viewer={ownerView} invite={invite} />,
    );
    // The owner's Remove is gone from Sam's row, and the sentence standing where it was is the
    // one the action returns if the write is attempted anyway — a row that hid the control and
    // said nothing would read as a bug.
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
    expect(screen.getByText(SETTLE_FIRST_MESSAGE)).toBeInTheDocument();
    // The owner's own row is untouched: no control on it is gated by a balance.
    expect(screen.getByRole('button', { name: 'Archive Lisbon' })).toBeInTheDocument();
    unmount();

    render(
      <MembersScreen group={group} members={[owner, owing]} viewer={memberView} invite={invite} />,
    );
    expect(screen.queryByRole('button', { name: 'Leave' })).not.toBeInTheDocument();
    expect(screen.getByText(SETTLE_FIRST_MESSAGE)).toBeInTheDocument();
  });

  it('confirms a leave in a dialog that names the group', () => {
    render(<MembersScreen group={group} members={[owner, other]} viewer={memberView} invite={invite} />);

    fireEvent.click(screen.getByRole('button', { name: 'Leave' }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Leave Lisbon?' })).toBeInTheDocument();
    expect(dialog).toHaveTextContent('You will stop seeing this group and its balances, until you undo.');
  });
});

describe('the home list', () => {
  it('has exactly one h1 when empty and exactly one h1 when not', () => {
    const empty = render(
      <GroupList groups={[]} {...noSummary} leftGroupId={null} leftGroupName={null} />,
    );
    expect(h1s(empty.container)).toHaveLength(1);
    expect(h1s(empty.container)[0]?.textContent).toBe("You're not in any groups yet.");
    empty.unmount();

    const listed = render(
      <GroupList groups={summaries} {...noSummary} leftGroupId={null} leftGroupName={null} />,
    );
    expect(h1s(listed.container)).toHaveLength(1);
    expect(h1s(listed.container)[0]?.textContent).toBe('Your groups');
  });

  it('renders a row per group with its type and the viewer’s own balance, and Create group', () => {
    const owed: GroupSummary[] = [{ ...summaries[0], balanceMinor: 1250n }];
    render(<GroupList groups={owed} {...noSummary} leftGroupId={null} leftGroupName={null} />);

    expect(screen.getByRole('link', { name: /Lisbon/ })).toHaveAttribute('href', `/groups/${group.id}`);
    expect(screen.getByText('trip')).toBeInTheDocument();
    // The caller's own figure, so it reads in the second person rather than as a third-person
    // row among others.
    expect(screen.getByText('you are owed')).toBeInTheDocument();
    expect(screen.getByText(/€12\.50/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create group' })).toHaveAttribute('href', '/groups/new');
  });

  it('renders the two totals with their per-person lines, at the headline size', () => {
    const totals: HomeSummaryTotals = {
      owedMinor: 1250n,
      oweMinor: 600n,
      owedBy: [{ memberId: other.memberId, displayName: 'Sam', amountMinor: 1250n }],
      oweTo: [{ memberId: owner.memberId, displayName: 'Priya', amountMinor: 600n }],
    };
    render(
      <GroupList
        groups={summaries}
        summary={totals}
        summaryCurrency="EUR"
        failedGroupIds={[]}
        leftGroupId={null}
        leftGroupName={null}
      />,
    );

    // The two --text-2xl figures, each with its direction as the label above it rather than as
    // colour on the number.
    const owed = screen.getByText('you are owed').parentElement as HTMLElement;
    const owe = screen.getByText('you owe').parentElement as HTMLElement;
    expect(owed.querySelector('.text-xl')).toHaveTextContent('€12.50');
    expect(owe.querySelector('.text-xl')).toHaveTextContent('€6.00');
    // The breakdown, directly beneath each figure, named per person.
    expect(screen.getByText('Sam')).toBeInTheDocument();
    expect(screen.getByText('Priya')).toBeInTheDocument();
  });

  it('withholds the totals and shows one inline error when a group fails to load', () => {
    const totals: HomeSummaryTotals = { owedMinor: 1250n, oweMinor: 0n, owedBy: [], oweTo: [] };
    render(
      <GroupList
        groups={summaries}
        summary={totals}
        summaryCurrency="EUR"
        failedGroupIds={[group.id]}
        leftGroupId={null}
        leftGroupName={null}
      />,
    );

    // The row keeps its name and loses its link, and offers the one action the pattern allows.
    expect(screen.getByText('Lisbon')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Lisbon/ })).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load this group's balances.");
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('shows the leave notice only for a name the server resolved', () => {
    const { unmount } = render(
      <GroupList groups={summaries} {...noSummary} leftGroupId={group.id} leftGroupName={null} />,
    );
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
    unmount();

    render(<GroupList groups={summaries} {...noSummary} leftGroupId={group.id} leftGroupName="Lisbon" />);
    expect(screen.getByText('You left Lisbon · Undo')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
  });

  it('shows the notice above the empty state when the group left was the only one', () => {
    // The second person in a fresh group leaves — the acceptance criterion's own walkthrough —
    // so the list is empty and the home screen renders HomeEmpty. The notice has to survive that
    // branch: it is the only Undo affordance for the leave, and leaving it to the list branch
    // hides it for exactly the person the notice was written for.
    const { container } = render(
      <GroupList groups={[]} {...noSummary} leftGroupId={group.id} leftGroupName="Lisbon" />,
    );

    expect(screen.getByText('You left Lisbon · Undo')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: "You're not in any groups yet." })).toBeInTheDocument();
    // HomeEmpty contributes the branch's single h1, and the notice contributes none.
    expect(h1s(container)).toHaveLength(1);
  });
});
