// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GroupRow, InviteRow, MemberRow, Membership } from '@/lib/access';
import { MembersScreen } from '@/components/members-screen';

// The invite block and the placeholder controls import Server Actions, which import the
// database. This suite asserts markup, so they are stand-ins that are never invoked.
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
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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
const placeholder: MemberRow = {
  memberId: 'm-placeholder',
  displayName: 'Robin',
  isOwner: false,
  isPlaceholder: true,
  balanceMinor: 0n,
};
const member: MemberRow = {
  memberId: 'm-sam',
  displayName: 'Sam',
  isOwner: false,
  isPlaceholder: false,
  balanceMinor: 0n,
};

const ownerView: Membership = { memberId: owner.memberId, groupId: group.id, userId: 'u-owner', isOwner: true };
const memberView: Membership = { memberId: member.memberId, groupId: group.id, userId: 'u-sam', isOwner: false };

const invite: InviteRow = { token: 'tok-abc123', enabled: true };

const TOKEN = 'tok-abc123';

describe('the invite block', () => {
  it('shows the link with Copy as the primary action, and the owner controls beside it', async () => {
    render(<MembersScreen group={group} members={[owner]} viewer={ownerView} invite={invite} />);

    // The token is in the field from the first render — only the origin is filled in once the
    // browser is known, which is why this waits rather than asserting immediately.
    const field = screen.getByLabelText<HTMLInputElement>('Invite link');
    await waitFor(() => expect(field.value).toBe(`http://localhost:3000/join/${TOKEN}`));

    expect(screen.getByRole('button', { name: 'Copy link' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Make a new link' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Turn off link' })).toBeInTheDocument();
  });

  it('confirms a copy in place', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });

    render(<MembersScreen group={group} members={[owner]} viewer={ownerView} invite={invite} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Link copied.'));
    expect(writeText).toHaveBeenCalledWith(`http://localhost:3000/join/${TOKEN}`);
  });

  it('falls back to a manual copy instruction when there is no clipboard to write to', async () => {
    // jsdom ships neither clipboard.writeText nor document.execCommand, which is exactly the
    // browser state this path exists for. Claiming a copy that did not happen would be worse
    // than saying what to press.
    render(<MembersScreen group={group} members={[owner]} viewer={ownerView} invite={invite} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Press Ctrl/Cmd+C to copy the selected link.'),
    );
  });

  it('hides the token and the owner controls from a plain member', () => {
    render(<MembersScreen group={group} members={[owner, member]} viewer={memberView} invite={invite} />);

    expect(screen.getByLabelText('Invite link')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Make a new link' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Turn off link' })).not.toBeInTheDocument();
  });

  it('offers no copyable link while the invite is turned off', () => {
    render(
      <MembersScreen
        group={group}
        members={[owner]}
        viewer={ownerView}
        invite={{ ...invite, enabled: false }}
      />,
    );

    expect(screen.getByText(/turned off/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('Invite link')).not.toBeInTheDocument();
    // The way back on is a new link, and the owner is offered exactly that.
    expect(screen.getByRole('button', { name: 'Make a link' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Turn off link' })).not.toBeInTheDocument();
  });
});

describe('placeholders on the members screen', () => {
  it('marks the row as a placeholder and gives a member a Claim action for it', () => {
    render(
      <MembersScreen group={group} members={[owner, placeholder, member]} viewer={memberView} invite={invite} />,
    );

    const row = screen.getByText('Robin').closest('li');
    expect(row).toHaveTextContent('Placeholder');
    expect(row).toHaveTextContent('Robin');
    // The Claim control is on the placeholder's row, named for the row it claims.
    expect(row).toContainElement(screen.getByRole('button', { name: 'Claim Robin' }));
  });

  it('gives the owner no Claim control, because there is no duplicate row to merge', () => {
    render(
      <MembersScreen group={group} members={[owner, placeholder]} viewer={ownerView} invite={invite} />,
    );

    expect(screen.getByText('Placeholder')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Claim Robin' })).not.toBeInTheDocument();
  });

  it('offers the owner a way to add somebody by name, and a member nothing', () => {
    const { unmount } = render(
      <MembersScreen group={group} members={[owner]} viewer={ownerView} invite={invite} />,
    );
    expect(screen.getByRole('heading', { name: 'Add a member by name' })).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add member' })).toBeInTheDocument();
    unmount();

    render(<MembersScreen group={group} members={[owner, member]} viewer={memberView} invite={invite} />);
    expect(screen.queryByRole('heading', { name: 'Add a member by name' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add member' })).not.toBeInTheDocument();
  });
});
