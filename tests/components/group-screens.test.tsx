// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { archiveGroup, renameGroup } from '@/app/actions/groups';
import { removeMember } from '@/app/actions/members';
import type { MemberResult } from '@/app/actions/members';
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
// One shared router for the whole file, so an assertion observes the SAME fns the components
// called. A fresh { push: vi.fn(), refresh: vi.fn() } per useRouter() call is what the old mock
// returned, and it makes every refresh assertion vacuous: it can only ever see a spy nobody used.
const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => router,
}));

afterEach(cleanup);

beforeEach(() => {
  // Reset, not merely clear: a case that installs an implementation to observe what the DOM held
  // when the refresh was dispatched must not leave it on for the next one.
  router.push.mockReset();
  router.refresh.mockReset();
});

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

/** Let every pending microtask and timer-less continuation settle before asserting a negative. */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
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

  it('names the rename form’s own field, so Save submits what is visible in it', () => {
    const { container } = render(<MembersScreen group={group} members={[owner]} viewer={ownerView} invite={invite} />);

    // The owner's members page renders two fields named `name`: the rename form's and "Add a
    // member by name"'s. Field built its id from the name alone, so both inputs carried
    // id="field-name" and the rename label's `for` resolved to whichever the document listed
    // first — the placeholder's. QA filled the field the label names and watched the Server
    // Action post the rename form's own INITIAL value, with a false 'Saved.' beside it.
    const rename = screen.getByLabelText('Group name');
    const placeholder = screen.getByLabelText('Name');
    expect(rename).not.toBe(placeholder);
    // The rename field shows the group as it is now; the placeholder field starts empty.
    expect(rename).toHaveValue('Lisbon');
    expect(placeholder).toHaveValue('');

    const labels = [...container.querySelectorAll('label')];
    expect(labels.filter((label) => label.htmlFor === rename.id)).toHaveLength(1);
    expect(labels.filter((label) => label.htmlFor === placeholder.id)).toHaveLength(1);
  });

  it('has the confirmation in the document at the moment it dispatches the refresh', async () => {
    vi.mocked(removeMember).mockResolvedValue({ ok: true, groupId: group.id });
    // What the DOM held at the moment the refresh was dispatched. This is the ordering a
    // jsdom test CAN see: refreshing from the committed state puts the status in the document
    // before the round trip is asked for, whereas refreshing from the wrapped action's awaited
    // continuation asks for it before useActionState has committed anything.
    //
    // The other half of AC-3 — that removeMember does not revalidate, so the commit this status
    // is inserted in cannot be raced by a re-rendered list unmounting the control with it — is a
    // Server Action property rather than a rendering one, and is pinned where it lives, in
    // tests/integration/members.test.ts.
    const confirmedWhenRefreshed: (HTMLElement | null)[] = [];
    router.refresh.mockImplementation(() => {
      confirmedWhenRefreshed.push(screen.queryByText('Removed Sam.'));
    });

    render(<MembersScreen group={group} members={[owner, other]} viewer={ownerView} invite={invite} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove Sam' }));

    await waitFor(() => expect(router.refresh).toHaveBeenCalledTimes(1));
    expect(confirmedWhenRefreshed[0]).not.toBeNull();
    expect(confirmedWhenRefreshed[0]).toHaveTextContent('Removed Sam.');
  });

  it('refreshes only once the removal has committed, never while it is in flight', async () => {
    let resolveRemove: ((result: MemberResult) => void) | undefined;
    vi.mocked(removeMember).mockImplementation(
      () =>
        new Promise<MemberResult>((resolve) => {
          resolveRemove = resolve;
        }),
    );

    render(<MembersScreen group={group} members={[owner, other]} viewer={ownerView} invite={invite} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove Sam' }));

    await waitFor(() => expect(removeMember).toHaveBeenCalledTimes(1));
    await settle();
    // In flight: there is no committed result yet, so there is nothing to confirm and nothing to
    // refresh for.
    expect(screen.queryByText('Removed Sam.')).not.toBeInTheDocument();
    expect(router.refresh).not.toHaveBeenCalled();

    resolveRemove?.({ ok: true, groupId: group.id });

    await waitFor(() => expect(screen.getByText('Removed Sam.')).toHaveAttribute('role', 'status'));
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it('confirms a removal in place and refreshes the list, leaving no live Remove button', async () => {
    vi.mocked(removeMember).mockResolvedValue({ ok: true, groupId: group.id });
    render(<MembersScreen group={group} members={[owner, other]} viewer={ownerView} invite={invite} />);

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove Sam' }));

    // The confirmation is inserted as the action resolves — a live region, so the removal is
    // announced and not merely visible — while the refresh is what drops the row underneath it.
    // Both are waited on together: the refresh is requested from a passive effect, and a
    // MutationObserver-driven wait can see the status in the DOM a tick before that effect runs.
    // Retrying costs nothing here and still fails if refresh is never called at all.
    await waitFor(() => {
      // The invite block renders a live region of its own on this screen, so the confirmation is
      // matched by its text and asserted to be the live region it is inserted as.
      expect(screen.getByText('Removed Sam.')).toHaveAttribute('role', 'status');
      expect(router.refresh).toHaveBeenCalled();
    });
    // Sam's row is the server's to remove, but until the refresh lands the button that just
    // removed him must not submit a second removal.
    expect(screen.getByRole('button', { name: 'Remove' })).toBeDisabled();
  });

  it('refreshes the server-rendered name around the form after a rename, alongside Saved.', async () => {
    vi.mocked(renameGroup).mockResolvedValue({ ok: true, groupId: group.id });
    render(<MembersScreen group={group} members={[owner]} viewer={ownerView} invite={invite} />);

    fireEvent.change(screen.getByLabelText('Group name'), { target: { value: 'Lisbon, April' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    // revalidatePath in the action invalidates the cache; what re-renders the back-link, the
    // paragraph under the heading and the home row is this refresh, and without it they keep the
    // old name until somebody reloads by hand. Waited on with the message, for the same
    // passive-effect reason as the removal case above.
    await waitFor(() => {
      expect(screen.getByText('Saved.')).toHaveAttribute('role', 'status');
      expect(router.refresh).toHaveBeenCalled();
    });
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

  it('shows the notice above the empty state when the group left was the only one', () => {
    // The second person in a fresh group leaves — the acceptance criterion's own walkthrough —
    // so the list is empty and the home screen renders HomeEmpty. The notice has to survive that
    // branch: it is the only Undo affordance for the leave, and leaving it to the list branch
    // hides it for exactly the person the notice was written for.
    const { container } = render(<GroupList groups={[]} leftGroupId={group.id} leftGroupName="Lisbon" />);

    expect(screen.getByText('You left Lisbon · Undo')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: "You're not in any groups yet." })).toBeInTheDocument();
    // HomeEmpty contributes the branch's single h1, and the notice contributes none.
    expect(h1s(container)).toHaveLength(1);
  });
});
