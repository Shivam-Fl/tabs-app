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
      <Link href="/" className="font-medium">
        Tabs
      </Link>
      <nav aria-label="Main" className="flex items-center gap-space-3">
        <Link href="/" className="min-h-[44px] leading-[44px] text-base">
          Groups
        </Link>
        <Link href="/settings" className="min-h-[44px] leading-[44px] text-base">
          {user.displayName}
        </Link>
        {action}
      </nav>
    </header>
  );
}