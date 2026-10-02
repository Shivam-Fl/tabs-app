// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { joinWithToken } from '@/app/actions/members';
import { JoinScreen } from '@/components/join-screen';

// The confirm is a Server Action, which imports the database. This suite asserts what the
// screen does with the answer, so the action is a stand-in the tests drive.
vi.mock('@/app/actions/members', () => ({
  joinWithToken: vi.fn(),
}));
// The push is the point of the success path, so the router is a stand-in this suite can read.
const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const GROUP_ID = '6b1f2f9c-0f1a-4a4f-9d1f-2f0a6c7b8d90';
const TOKEN = 'tok-abc123';

function screenFor(overrides: Partial<Parameters<typeof JoinScreen>[0]> = {}) {
  return render(
    <JoinScreen token={TOKEN} groupId={GROUP_ID} groupName="Lisbon" isMember={false} {...overrides} />,
  );
}

describe('the join screen', () => {
  it('asks to join the group the link names, and carries the token in the body', () => {
    screenFor();

    expect(screen.getByRole('heading', { name: 'Join Lisbon?' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Join Lisbon' })).toBeInTheDocument();
    // The token travels in the form rather than in the action's arguments, so that the no-JS
    // submission posts exactly what the button posts.
    expect(screen.getByDisplayValue(TOKEN)).toHaveAttribute('name', 'token');
  });

  it('confirms, then opens the group the action answered with', async () => {
    vi.mocked(joinWithToken).mockResolvedValue({ ok: true, groupId: GROUP_ID });
    screenFor();

    fireEvent.click(screen.getByRole('button', { name: 'Join Lisbon' }));

    await waitFor(() => expect(push).toHaveBeenCalledWith(`/groups/${GROUP_ID}`));
    const [, body] = vi.mocked(joinWithToken).mock.calls[0] ?? [];
    expect(body?.get('token')).toBe(TOKEN);
  });

  it('shows the answer rather than the question once the join has happened', async () => {
    vi.mocked(joinWithToken).mockResolvedValue({ ok: true, groupId: GROUP_ID });
    screenFor();

    fireEvent.click(screen.getByRole('button', { name: 'Join Lisbon' }));

    // A confirmed link is spent: the screen stops asking and offers the way in instead. This is
    // also the state the server re-renders the page into straight after the write, so the two
    // have to agree — otherwise the answer flickers back to a question.
    await waitFor(() => expect(screen.getByRole('heading', { name: /already in Lisbon/ })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Join Lisbon' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Lisbon' })).toHaveAttribute('href', `/groups/${GROUP_ID}`);
  });

  it('renders a refusal as a sentence and stays put', async () => {
    vi.mocked(joinWithToken).mockResolvedValue({ ok: false, formError: 'That invite link is no longer valid.' });
    screenFor();

    fireEvent.click(screen.getByRole('button', { name: 'Join Lisbon' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('That invite link is no longer valid.'),
    );
    expect(push).not.toHaveBeenCalled();
    // Still able to try again if the owner hands over a fresh link on this screen.
    expect(screen.getByRole('button', { name: 'Join Lisbon' })).toBeInTheDocument();
  });

  it('does not ask someone who is already in — the link was used on an earlier visit', () => {
    screenFor({ isMember: true });

    expect(screen.getByRole('heading', { name: /already in Lisbon/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Join Lisbon' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Lisbon' })).toHaveAttribute('href', `/groups/${GROUP_ID}`);
  });
});
