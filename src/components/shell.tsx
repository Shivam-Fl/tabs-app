import type { ReactNode } from 'react';

import { signOut } from '@/app/actions/auth';
import { TopBar } from '@/components/ui';

/**
 * The signed-in shell: the top bar and a <main> landmark.
 *
 * Synchronous and presentational on purpose. The layout that renders it is async because
 * requireUser() is async, and a Server Component that awaits cookies() cannot be rendered by
 * @testing-library/react — so extracting the markup is what lets the component test compose a
 * real screen and assert its single h1.
 */
export function Shell({ user, children }: { user: { displayName: string }; children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <TopBar user={user} action={<SignOutControl />} />
      <main id="main" className="mx-auto w-full max-w-[720px] flex-1 px-space-6 py-space-8">
        {children}
      </main>
    </div>
  );
}

/**
 * Sign-out is a form posting the Server Action, so it needs no client state at all.
 *
 * It is a bare control rather than the profile menu docs/ui.md describes, because no menu
 * primitive exists in the design system yet. QA is told not to report that.
 */
function SignOutControl() {
  return (
    <form action={signOut}>
      <button
        type="submit"
        className="min-h-[44px] px-space-2 text-base text-text-muted transition-colors duration-150 hover:text-text"
      >
        Sign out
      </button>
    </form>
  );
}