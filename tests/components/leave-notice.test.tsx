// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LeaveNotice } from '@/components/leave-notice';

// The component imports a Server Action, which imports the database. This suite asserts markup
// and the timer, so the action is replaced with a stand-in that is never invoked.
vi.mock('@/app/actions/members', () => ({
  leaveGroup: vi.fn(),
  undoLeave: vi.fn(),
  removeMember: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

afterEach(cleanup);

const GROUP_ID = '6b1f2f9c-0f1a-4a4f-9d1f-2f0a6c7b8d90';

/**
 * The offset assertion the plan was rejected for getting wrong, so it is stated on the string
 * that is actually asserted.
 *
 * RENDERED: 'You left Lisbon · Undo' — the middle dot at 16, a space at 17.
 * TEMPLATE: 'You left <group> · Undo' — the dot at 17, because '<group>' is seven characters
 * where 'Lisbon' is six. The two forms are named separately here so that no offset is ever
 * carried from one to the other; the template is asserted too, as a different string, so the
 * distinction is a test rather than a comment.
 */
describe('the leave notice', () => {
  it('renders "You left Lisbon · Undo" with U+00B7 at offset 16 and a space at 17', () => {
    render(<LeaveNotice groupId={GROUP_ID} groupName="Lisbon" />);

    const rendered = screen.getByText(/You left/).textContent ?? '';
    expect(rendered).toBe('You left Lisbon · Undo');
    expect(rendered.codePointAt(16)).toBe(0x00b7);
    expect(rendered.codePointAt(17)).toBe(0x0020);

    // An ASCII hyphen is a different string at that offset, which is what CI would otherwise let
    // through to a reader.
    expect('You left Lisbon - Undo'.codePointAt(16)).toBe(0x002d);

    // The template form, named distinctly: seven-character placeholder, dot one place later —
    // and offset 16, which holds the dot in the rendered string, holds the space here.
    expect('You left <group> · Undo'.codePointAt(17)).toBe(0x00b7);
    expect('You left <group> · Undo'.codePointAt(16)).toBe(0x0020);
  });

  it('offers Undo as a real form, so it is one submit with or without JavaScript', () => {
    render(<LeaveNotice groupId={GROUP_ID} groupName="Lisbon" />);

    const undo = screen.getByRole('button', { name: 'Undo' });
    expect(undo).toHaveAttribute('type', 'submit');

    const form = undo.closest('form');
    expect(form).not.toBeNull();
    expect(form?.querySelector<HTMLInputElement>('input[name="groupId"]')?.value).toBe(GROUP_ID);
  });

  it('hides the row after ten seconds without a reload', () => {
    vi.useFakeTimers();
    try {
      render(<LeaveNotice groupId={GROUP_ID} groupName="Lisbon" />);
      expect(screen.getByText(/You left Lisbon/)).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(10_000);
      });

      expect(screen.queryByText(/You left Lisbon/)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders nothing at all when the page could not resolve a group name', () => {
    // The name is always server-resolved. A URL that names a group the caller never left
    // resolves to null, and this is what the row does with null.
    const { container } = render(<LeaveNotice groupId={GROUP_ID} groupName={null} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });
});
