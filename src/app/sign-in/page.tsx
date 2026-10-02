import type { Metadata } from 'next';

import { AuthForm } from '@/components/auth-form';

export const metadata: Metadata = { title: 'Sign in · Tabs' };

/**
 * One centred card, capped at 360px, with no site navigation beyond the brand name.
 *
 * It sits outside the (app) route group so a signed-out visitor never runs the shell, and it
 * renders for a signed-in visitor too — no redirect is added in this ticket, because the QA
 * script's double-submit step needs the sign-up form.
 */
export default function SignInPage() {
  return (
    <main id="main" className="flex min-h-screen items-center justify-center bg-bg p-space-6">
      <AuthForm mode="sign-in" />
    </main>
  );
}
