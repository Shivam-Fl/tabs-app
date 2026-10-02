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
      <nav aria-label="Main" className="flex items-center gap-space-3">
        <Link href="/" className="min-h-[44px] leading-[44px] text-base">
          Groups
        </Link>
        {/* The display name is user-supplied, so its width is not knowable here: "Jo" renders
            15px wide and "Priya" 40px, both under the 44px minimum. Same three utilities as
            the brand link for the same reason — min-width has to be asserted, not assumed. */}
        <Link href="/settings" className="inline-flex min-h-[44px] min-w-[44px] items-center text-base">
          {user.displayName}
        </Link>
        {action}
      </nav>
    </header>
  );
}