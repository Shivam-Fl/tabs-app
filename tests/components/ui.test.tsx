// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import RootLayout from '@/app/layout';
import { Shell } from '@/components/shell';
import { AuthForm } from '@/components/auth-form';
import { HomeEmpty } from '@/components/home-empty';
import { Button, Card, Dialog, EmptyState, ErrorState, Field, Input, Money, Skeleton, TopBar } from '@/components/ui';

// Shell's sign-out control and AuthForm both import Server Actions, which import the
// database. This suite asserts markup, so they are replaced with the smallest stand-in that
// keeps the components renderable: the actions are never invoked, and the router is a no-op.
vi.mock('@/app/actions/auth', () => ({
  signIn: vi.fn(),
  signUp: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

/**
 * The structural half of AC-10, on the composition the pages actually render.
 *
 * The pages themselves are async Server Components awaiting cookies(), so testing-library
 * cannot render them and importing one would construct a real database. Shell and HomeEmpty
 * are extracted precisely so this composition exists — and only a composition can prove
 * "exactly one h1" rather than "at most one per component".
 */

afterEach(cleanup);

const user = { displayName: 'Priya' };

/** Every heading level in document order, as numbers. */
function headingLevels(container: HTMLElement): number[] {
  return [...container.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((element) =>
    Number(element.tagName.slice(1)),
  );
}

describe('a real screen composition', () => {
  it('has exactly one h1 and heading levels that descend without skipping', () => {
    const { container } = render(
      <Shell user={user}>
        <HomeEmpty />
      </Shell>,
    );

    const headings = container.querySelectorAll('h1');
    expect(headings).toHaveLength(1);
    expect(headings[0]?.textContent).toBe("You're not in any groups yet.");

    const levels = headingLevels(container);
    expect(levels[0]).toBe(1);
    for (let index = 1; index < levels.length; index += 1) {
      // Descending is fine; ascending may not skip a level.
      expect(levels[index] - levels[index - 1]).toBeLessThanOrEqual(1);
    }
  });

  it('renders the empty state verbatim, with one action', () => {
    render(
      <Shell user={user}>
        <HomeEmpty />
      </Shell>,
    );

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent("You're not in any groups yet.");
    expect(screen.getByRole('link', { name: 'Create group' })).toBeInTheDocument();
    expect(screen.getByText(/invite link/i)).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Create group' })).toHaveLength(1);
  });

  it('every control has a bound label', () => {
    const { container } = render(
      <form>
        <Field name="email" label="Email" type="email" />
        <Field name="password" label="Password" type="password" />
      </form>,
    );

    for (const control of container.querySelectorAll('input')) {
      const label = container.querySelector(`label[for="${control.id}"]`);
      expect(label, `no <label for> bound to #${control.id}`).not.toBeNull();
      expect(label?.textContent?.trim().length).toBeGreaterThan(0);
    }
  });

  it('associates a field error with its input through aria-describedby, and never by red alone', () => {
    const { container } = render(<Field name="email" label="Email" error="Enter a valid email address." />);

    const input = container.querySelector('input');
    const describedBy = input?.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();

    const message = container.querySelector(`#${CSS.escape(describedBy as string)}`);
    expect(message).not.toBeNull();
    expect(message).toHaveTextContent('Enter a valid email address.');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    // The text carries the failure, so it survives a screen reader and a colour-blind reader.
    expect(message?.textContent).not.toBe('');
  });

  it('no colour literal reaches the markup — every screen is built from the theme tokens', () => {
    const { container } = render(
      <Shell user={user}>
        <HomeEmpty />
      </Shell>,
    );
    // Tailwind classes only: a hex or an rgb() here would be a screen that ignored the theme.
    expect(container.innerHTML).not.toMatch(/#[0-9a-f]{3,6}\b/i);
    expect(container.innerHTML).not.toMatch(/rgb\(/i);
  });
});

describe('the ten primitives', () => {
  it('each renders with exactly one h1 or none, and none forces a second h1 into a composition', () => {
    render(
      <div>
        <EmptyState headingLevel="h1" title="No expenses yet." description="Add the first one." />
      </div>,
    );
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    cleanup();

    // Composed into a shell that already owns its h1, it must not add one of its own.
    render(
      <Shell user={user}>
        <HomeEmpty />
        <EmptyState title="No expenses yet." description="Add the first one." />
      </Shell>,
    );
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    cleanup();

    // The primitives that own no heading at all.
    for (const element of [
      <Card key="card">card</Card>,
      <Button key="button">Press</Button>,
      <Input key="input" label="Email" />,
      <Skeleton key="skeleton" />,
      <Money key="money" formatted="₹420.00" direction="owed" />,
      <TopBar key="bar" user={user} />,
      <ErrorState key="error" message="Couldn't load this page." onRetry={() => {}} />,
    ]) {
      const { container } = render(element);
      expect(container.querySelectorAll('h1')).toHaveLength(0);
      cleanup();
    }
  });

  it('distinguishes no-data-yet from no-results, and never confuses them', () => {
    render(<EmptyState title="No expenses yet." description="Add the first one." />);
    expect(screen.queryByText(/clear the filters/i)).not.toBeInTheDocument();
    cleanup();

    render(<EmptyState kind="no-results" title="No expenses match these filters." />);
    expect(screen.getByText(/clear the filters/i)).toBeInTheDocument();
  });

  it('states a money direction in words, never as a bare minus sign', () => {
    const { container } = render(<Money formatted="-180.50" direction="owes" />);
    expect(container.textContent).toContain('you owe');
    // The word is in the accessible text, so it is not colour-alone information.
    expect(container.querySelector('.sr-only')?.textContent).toContain('you owe');
  });

  it('renders the empty, loading and error states as text — no spinner, no shimmer', () => {
    const loading = render(<Skeleton className="h-12" />);
    // A skeleton is a placeholder for the eye, and is hidden from everything else.
    expect(loading.container.querySelector('[aria-hidden="true"]')).not.toBeNull();
    expect(loading.container.innerHTML).not.toMatch(/animate|shimmer|spinner/i);
    cleanup();

    const failed = render(<ErrorState message="Couldn't load your balances." onRetry={() => {}} />);
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load your balances.");
    expect(failed.container.textContent).not.toMatch(/Error:|at .*\.tsx:\d+/);
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('a destructive dialog names the thing and its consequence, and is dismissible by Escape', () => {
    let cancelled = false;
    render(
      <Dialog
        open
        title="Remove Priya from Lisbon?"
        consequence="She will no longer appear in this group's balances."
        confirmLabel="Remove Priya"
        onConfirm={() => {}}
        onCancel={() => {
          cancelled = true;
        }}
      />,
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByText("She will no longer appear in this group's balances.")).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Remove Priya' })).toBeInTheDocument();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(cancelled).toBe(true);
  });
});

describe('the top bar', () => {
  it('is the whole navigation — no hamburger, no bottom tab bar', () => {
    const { container } = render(<TopBar user={user} />);

    expect(screen.getByRole('link', { name: 'Tabs' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: 'Groups' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: 'Priya' })).toHaveAttribute('href', '/settings');
    expect(container.querySelector('nav')).not.toBeNull();
    expect(container.querySelector('[aria-expanded]')).toBeNull();
  });
});

/**
 * The 44px minimum touch target, asserted on the markup that produces it.
 *
 * These assert the CLASSES, never a measured height, and they have to: jsdom computes no
 * layout, so getBoundingClientRect() returns 0x0 for every element on earth and a test that
 * read it would pass at 44px and fail at 19px for reasons that have nothing to do with the
 * code. The measured 44px and the 8px separation are asserted by AC-12 in a real browser,
 * which is the only place they are observable — nothing CI runs can see them.
 *
 * What these guard is the half of BUG-1 that lives in the markup: three inline anchors whose
 * min-height the engine silently discards, because min-height does not apply to a
 * non-replaced inline box. `inline-flex` is what makes the utility apply at all, so it is
 * asserted and not left as a comment — dropping it is exactly the patch that looks right and
 * leaves the link at 24px.
 */
describe('every link is a 44px target', () => {
  it('the top-bar brand link carries both minimums and is not a bare inline anchor', () => {
    render(<TopBar user={user} />);

    const brand = screen.getByRole('link', { name: 'Tabs' });
    expect(brand.className).toContain('min-h-[44px]');
    expect(brand.className).toContain('min-w-[44px]');
    expect(brand.className).toContain('inline-flex');
  });

  it.each([
    ['sign-up', 'Sign in'],
    ['sign-in', 'Create an account'],
  ])('the %s cross-link to "%s" carries both minimums and is not a bare inline anchor', (mode, name) => {
    render(<AuthForm mode={mode as 'sign-in' | 'sign-up'} />);

    const crossLink = screen.getByRole('link', { name });
    expect(crossLink.className).toContain('min-h-[44px]');
    expect(crossLink.className).toContain('min-w-[44px]');
    expect(crossLink.className).toContain('inline-flex');
  });
});

/**
 * The touch-target markup jsdom cannot measure, for the two controls that were wrong.
 *
 * The same caveat as above applies with more force: jsdom computes no layout and returns 0x0
 * for every element, so nothing here reads getBoundingClientRect(). These assert the CLASSES
 * that produce a 44px target and a bounded width, never a measured size. The measured claims
 * are AC-13 and AC-14, which are browser-only and cannot be duplicated here — a later reader
 * must not "strengthen" these into layout assertions that would return zero regardless of
 * whether the code is right.
 */
describe('the touch-target markup, which jsdom cannot measure', () => {
  it('the skip link carries both minimums, is not a bare inline anchor, and is not positioned', () => {
    render(
      <RootLayout>
        <main id="main" />
      </RootLayout>,
    );

    // RootLayout reaches no database — it renders /sign-in and /sign-up for a signed-out
    // visitor — which is why it is safe to render here rather than opening src/db.
    const skipLink = screen.getByRole('link', { name: 'Skip to content' });
    expect(skipLink.className).toContain('focus:min-h-[44px]');
    expect(skipLink.className).toContain('focus:min-w-[44px]');
    expect(skipLink.className).toContain('focus:items-center');
    expect(skipLink.className).toContain('focus:inline-flex');

    // The negative half is the point. focus:not-sr-only already sets position: static and
    // focus:absolute sorted later in the utilities layer and put the link on top of the
    // brand link at dx=0 dy=0. Adding the minimums alone would fix the height and leave the
    // overlap, and this is the half a later edit reinstates out of habit.
    expect(skipLink.className).not.toMatch(/focus:absolute|focus:left-space-|focus:top-space-/);
  });

  it('a one-word display name is capped, truncated and shrinkable', () => {
    render(<TopBar user={{ displayName: 'Wolfeschlegelsteinhausenbergerdorffenfun' }} />);

    // All three are needed and none alone is enough: the span is what makes the ellipsis
    // render (text-overflow does not reliably apply to a flex container's own text), the
    // max-width is what bounds the item's min-content contribution, and min-w-0 on the nav
    // is what lets the row shrink at all.
    const nameLink = screen.getByRole('link', { name: 'Wolfeschlegelsteinhausenbergerdorffenfun' });
    expect(nameLink.className).toContain('max-w-[120px]');
    expect(within(nameLink).getByText('Wolfeschlegelsteinhausenbergerdorffenfun').className).toContain(
      'truncate',
    );
    expect(document.querySelector('nav')?.className).toContain('min-w-0');
  });
});