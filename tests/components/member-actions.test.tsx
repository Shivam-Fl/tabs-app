// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { leaveGroup, removeMember } from '@/app/actions/members';
import type { MemberResult } from '@/app/actions/members';
import { LeaveButton, RemoveButton } from '@/components/member-actions';

// Both controls are Server Actions that reach the database. This suite asserts where the screen
// goes after the answer, so the actions are stand-ins the tests resolve by hand — which is the
// only way to unmount the control between the submit and the result, as the real leave does.
vi.mock('@/app/actions/members', () => ({
  leaveGroup: vi.fn(),
  removeMember: vi.fn(),
}));
// The navigation is the point of the leave path, so the router is a stand-in this suite reads.
const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const GROUP_ID = '6b1f2f9c-0f1a-4a4f-9d1f-2f0a6c7b8d90';
const MEMBER_ID = '1c4a7e02-5b3d-4f8a-9c21-0d7e6b5a4f33';

/**
 * Press a button by its accessible name. The trigger and the dialog's confirm are told apart by
 * their labels ('Leave' against 'Leave Lisbon'), and confirming submits the same hidden form the
 * dialog's onConfirm does.
 */
function press(name: string) {
  fireEvent.click(screen.getByRole('button', { name }));
}

/** Let every pending microtask and timer-less continuation settle before asserting a negative. */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('leaving from the members page', () => {
  it('navigates home from the action continuation, after the write has unmounted the control', async () => {
    let resolveLeave: ((result: MemberResult) => void) | undefined;
    vi.mocked(leaveGroup).mockImplementation(
      () =>
        new Promise<MemberResult>((resolve) => {
          resolveLeave = resolve;
        }),
    );

    const { unmount } = render(<LeaveButton groupId={GROUP_ID} groupName="Lisbon" />);
    press('Leave');
    press('Leave Lisbon');
    await waitFor(() => expect(leaveGroup).toHaveBeenCalledTimes(1));

    // The leave's revalidatePath re-renders the members page as notFound for a person who is no
    // longer a member, so the committing render unmounts this control before the result arrives.
    // An effect on the action state is discarded with it; the pending promise is not part of the
    // tree, so the continuation below still runs and the Undo notice is reachable.
    unmount();
    resolveLeave?.({ ok: true, groupId: GROUP_ID });

    await waitFor(() => expect(push).toHaveBeenCalledWith(`/?left=${GROUP_ID}`));
  });

  it('renders a refused leave in place, with no navigation', async () => {
    vi.mocked(leaveGroup).mockResolvedValue({
      ok: false,
      formError: 'You own this group, so you can’t leave it.',
    });

    render(<LeaveButton groupId={GROUP_ID} groupName="Lisbon" />);
    press('Leave');
    press('Leave Lisbon');

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('You own this group, so you can’t leave it.'),
    );
    expect(push).not.toHaveBeenCalled();
  });
});

describe('removing somebody else', () => {
  it('stays on the page: a successful removal navigates nowhere', async () => {
    vi.mocked(removeMember).mockResolvedValue({ ok: true, groupId: GROUP_ID });

    render(<RemoveButton groupId={GROUP_ID} memberId={MEMBER_ID} memberName="Sam" />);
    press('Remove');
    press('Remove Sam');

    // The shared hook's other caller: the removal happened on this screen, so this screen is
    // where it shows. The continuation fires nothing for it, before or after the fix.
    await waitFor(() => expect(removeMember).toHaveBeenCalledTimes(1));
    await settle();
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
  });
});
