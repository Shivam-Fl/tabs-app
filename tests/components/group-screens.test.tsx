// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { archiveGroup } from '@/app/actions/groups';
import { GroupList } from '@/components/group-list';
import { GroupOverview } from '@/components/group-overview';
import { MembersScreen } from '@/components/members-screen';
import type { ActivityRow, GroupRow, GroupSummary, InviteRow, MemberRow, Membership } from '@/lib/access';

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

function h1s(container: HTMLElement): Element[] {
  return [...container.querySelectorAll('h1')];
}

describe('the group overview', () => {
  it('has exactly one h1 and shows the name, type and currency', () => {
    const { container } = render(<GroupOverview group={group} members={[owner]} entries={[]} />);

    expect(h1s(container)).toHaveLength(1);
    expect(h1s(container)[0]?.textContent).toBe('Lisbon');
    expect(screen.getByText('trip · EUR')).toBeInTheDocument();
  });

  it('renders every member at a formatted zero, in the group’s currency', () => {
    render(<GroupOverview group={group} members={[owner, other]} entries={[entry]} />);

    // The symbol form, per TR-23: '€0.00' and not 'EUR 0.00'.
    expect(screen.getAllByText(/€0\.00/)).toHaveLength(2);
    // And the direction is in words, so the amount survives a screen reader and a colour-blind
    // reader: neither member is owed anything, and the primitive says so.
    expect(screen.getAllByText('settled:')).toHaveLength(2);
  });

  it('renders the archived notice for an archived group', () => {
    const { unmount } = render(<GroupOverview group={group} members={[owner]} entries={[]} />);
    expect(screen.queryByText('This group is archived.')).not.toBeInTheDocument();
    unmount();

    render(
      <GroupOverview group={{ ...group, archivedAt: new Date('2026-02-01T00:00:00.000Z') }} members={[owner]} entries={[]} />,
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
      <GroupList groups={[]} leftGroupId={null} leftGroupName={null} />,
    );
    expect(h1s(empty.container)).toHaveLength(1);
    expect(h1s(empty.container)[0]?.textContent).toBe("You're not in any groups yet.");
    empty.unmount();

    const listed = render(
      <GroupList groups={summaries} leftGroupId={null} leftGroupName={null} />,
    );
    expect(h1s(listed.container)).toHaveLength(1);
    expect(h1s(listed.container)[0]?.textContent).toBe('Your groups');
  });

  it('renders a row per group with its type and the viewer’s balance, and Create group', () => {
    render(<GroupList groups={summaries} leftGroupId={null} leftGroupName={null} />);

    expect(screen.getByRole('link', { name: /Lisbon/ })).toHaveAttribute('href', `/groups/${group.id}`);
    expect(screen.getByText('trip')).toBeInTheDocument();
    expect(screen.getByText(/€0\.00/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create group' })).toHaveAttribute('href', '/groups/new');
  });

  it('shows the leave notice only for a name the server resolved', () => {
    const { unmount } = render(<GroupList groups={summaries} leftGroupId={group.id} leftGroupName={null} />);
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
    unmount();

    render(<GroupList groups={summaries} leftGroupId={group.id} leftGroupName="Lisbon" />);
    expect(screen.getByText('You left Lisbon · Undo')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
  });
});
