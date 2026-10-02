import Link from 'next/link';

/**
 * The whole navigation. docs/ui.md forbids a hamburger and a bottom tab bar: every screen is
 * at most two taps from home, so the parts are named once here.
 */
export function TopBar({
  user,
  action,
}: {
  user: { displayName: string };
  /** Rendered by the signed-in shell: the sign-out control, which is a form action. */
  action?: React.ReactNode;
}) {
  return (
    <header className="flex min-h-[44px] items-center justify-between gap-space-3 border-b border-border px-space-4 py-space-2 sm:px-space-6">
      {/* inline-flex is what makes min-h apply: a link is an inline box by default and the
          engine discards a minimum height on one. min-w is here because "Tabs" is 35px of
          text and the 44px minimum is on both axes. */}
      <Link href="/" className="inline-flex min-h-[44px] min-w-[44px] items-center font-medium">
        Tabs
      </Link>
      <nav aria-label="Main" className="flex min-w-0 items-center gap-space-3">
        <Link href="/" className="shrink-0 min-h-[44px] leading-[44px] text-base">
          Groups
        </Link>
        {/* The display name is user-supplied, so its width is not knowable here: "Jo" renders
            15px wide and "Priya" 40px, both under the 44px minimum, and a legal one-word name
            renders 318px and pushes the page sideways. Same three utilities as the brand link
            for the same reason — min-width has to be asserted, not assumed. Three classes do
            the layout and each is load-bearing: the span makes the ellipsis render,
            min-w-0 on the nav is what lets the row shrink below its content, and shrink-0 on
            the siblings keeps that shrink coming from the name alone. A fixed max-width here
            was BUG-4 — it truncated an ordinary 29-character name on a 1280px header with
            1160px free, because a ceiling applies at every viewport rather than only where the
            bar is tight, and the row shrinks fine without it. */}
        <Link
          href="/settings"
          className="inline-flex min-h-[44px] min-w-[44px] items-center text-base"
        >
          <span className="truncate">{user.displayName}</span>
        </Link>
        {action}
      </nav>
    </header>
  );
}
